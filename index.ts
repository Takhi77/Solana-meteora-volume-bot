import {
  getAssociatedTokenAddress,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js'
import {
  BUY_INTERVAL_MAX,
  BUY_INTERVAL_MIN,
  SELL_INTERVAL_MAX,
  SELL_INTERVAL_MIN,
  BUY_LOWER_PERCENT,
  BUY_UPPER_PERCENT,
  DISTRIBUTE_WALLET_NUM,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT,
  TOKEN_NAME,
  WISH_WORD,
  SWAP_ROUTING,
  POOL_ID,
} from './constants'
import { Data, readJson, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx, getBuyTxWithJupiter, getSellTx, getSellTxWithJupiter } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy'
import { obfuscateString, sendMessage } from './utils/tgNotification'
import axios from 'axios'
import { swapOnMeteora, swapOnMeteoraDYN } from './utils/meteoraSwap'
import BN from 'bn.js'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment: "confirmed"
})

const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(TOKEN_MINT)
const quoteMint = new PublicKey("So11111111111111111111111111111111111111112")
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM
const remainSol = 3 * 10 ** 7;

const main = async () => {

  const solBalance = await solanaConnection.getBalance(mainKp.publicKey)
  console.log(`Volume bot is running`)
  console.log(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  console.log(`Pool token mint: ${baseMint.toBase58()}`)
  console.log(`Wallet SOL balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(3)}SOL`)
  console.log(`Buying wait time max: ${BUY_INTERVAL_MAX}s`)
  console.log(`Buying wait time min: ${BUY_INTERVAL_MIN}s`)
  console.log(`Selling wait time max: ${SELL_INTERVAL_MAX}s`)
  console.log(`Selling wait time min: ${SELL_INTERVAL_MIN}s`)
  console.log(`Buy upper limit percent: ${BUY_UPPER_PERCENT}%`)
  console.log(`Buy lower limit percent: ${BUY_LOWER_PERCENT}%`)
  console.log(`Distribute SOL to ${distritbutionNum} wallets`)

  let data: {
    kp: Keypair;
    buyAmount: number;
  }[] | null = null

  if (solBalance < (BUY_LOWER_PERCENT + 0.002) * distritbutionNum) {
    console.log("Sol balance is not enough for distribution")
  }

  data = await distributeSol(solanaConnection, mainKp, distritbutionNum)
  if (data == null || data.length == 0) {
    console.log("Distribution failed")
    return
  }

  data.map(async ({ kp }, i) => {
    await sleep(i * 30000)
    let srcKp = kp
    while (true) {
      // buy part with random percent
      const BUY_WAIT_INTERVAL = Math.round(Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN)
      const SELL_WAIT_INTERVAL = Math.round(Math.random() * (SELL_INTERVAL_MAX - SELL_INTERVAL_MIN) + SELL_INTERVAL_MIN)
      const solBalance = await solanaConnection.getBalance(srcKp.publicKey)

      let buyAmountInPercent = Number((Math.random() * (BUY_UPPER_PERCENT - BUY_LOWER_PERCENT) + BUY_LOWER_PERCENT).toFixed(3))

      if (solBalance < remainSol) {
        console.log("Sol balance is not enough in one of wallets")
        return
      }

      let buyAmountFirst = Math.floor((solBalance - remainSol - 10 ** 7) / 100 * buyAmountInPercent)
      let buyAmountSecond = Math.floor(solBalance - buyAmountFirst - remainSol - 10 ** 7)

      console.log(`balance: ${solBalance / LAMPORTS_PER_SOL} first: ${buyAmountFirst / LAMPORTS_PER_SOL} second: ${buyAmountSecond / LAMPORTS_PER_SOL}`)
      // try buying until success
      let i = 0

      while (true) {
        try {
          if (i > 10) {
            console.log("Error in buy transaction")
            return;
          }
          const result = await buy(srcKp, baseMint, buyAmountFirst)
          if (result) {
            console.log("buy by first amount: ", result)
            break
          } else {
            i++
            await sleep(2000)
          }
        } catch (error) {
          i++
        }
      }

      let l = 0
      while (true) {
        try {
          if (l > 10) {
            console.log("Error in buy transaction")
            return;
          }
          const result = await buy(srcKp, baseMint, buyAmountSecond)
          if (result) {
            console.log("buy by second amount: ", result)
            break
          } else {
            l++
            await sleep(2000)
          }
        } catch (error) {
          l++
        }
      }

      await sleep(BUY_WAIT_INTERVAL * 1000)

      // try selling until success
      let j = 0
      while (true) {
        if (j > 10) {
          console.log("Error in sell transaction")
          return
        }
        const result = await sell(baseMint, srcKp)
        if (result) {
          console.log("sell all tokens: ", result)
          break
        } else {
          j++
          await sleep(2000)
        }
      }

      await sleep(SELL_WAIT_INTERVAL * 1000)

      // SOL transfer part

      const balance = await solanaConnection.getBalance(srcKp.publicKey)
      if (balance < remainSol) {
        console.log("Sub wallet balance is not enough to continue volume swap")
        return
      }
      let k = 0
      while (true) {
        try {
          if (k > 5) {
            console.log("Failed to transfer SOL to new wallet in one of sub wallet")
            return
          }
          const destinationKp = Keypair.generate()

          const tx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
            SystemProgram.transfer({
              fromPubkey: srcKp.publicKey,
              toPubkey: destinationKp.publicKey,
              lamports: balance - remainSol
            })
          )

          tx.feePayer = srcKp.publicKey
          tx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash

          const saveResult = saveDataToFile([{
            privateKey: base58.encode(destinationKp.secretKey),
            pubkey: destinationKp.publicKey.toBase58(),
          }])
          if (!saveResult) throw new Error();
          const sig = await sendAndConfirmTransaction(solanaConnection, tx, [srcKp], { skipPreflight: true, commitment: "finalized" })
          srcKp = destinationKp
          const bal = await solanaConnection.getBalance(destinationKp.publicKey) / LAMPORTS_PER_SOL
          console.log(bal, "SOL")
          console.log(`Transferred SOL to new wallet after buy and sell, https://solscan.io/tx/${sig}`)
          break
        } catch (error) {
          k++
        }
      }
    }
  })
}

const distributeSol = async (connection: Connection, mainKp: Keypair, distritbutionNum: number) => {
  const data: Data[] = []
  const wallets = []
  try {
    const sendSolTx: TransactionInstruction[] = []
    sendSolTx.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 })
    )
    const mainSolBal = await connection.getBalance(mainKp.publicKey)
    if (mainSolBal <= 10 ** 7) {
      console.log("Main wallet balance is not enough")
      return []
    }
    let solAmount = Math.floor((mainSolBal - remainSol) / distritbutionNum)
    console.log("distributing amount: ", solAmount)

    for (let i = 0; i < distritbutionNum; i++) {

      const wallet = Keypair.generate()
      wallets.push({ kp: wallet, buyAmount: solAmount })

      sendSolTx.push(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: solAmount
        })
      )
    }

    let index = 0
    while (true) {
      try {
        if (index > 5) {
          console.log("Error in distribution")
          return null
        }
        const siTx = new Transaction().add(...sendSolTx)
        const latestBlockhash = await solanaConnection.getLatestBlockhash()
        siTx.feePayer = mainKp.publicKey
        siTx.recentBlockhash = latestBlockhash.blockhash
        const messageV0 = new TransactionMessage({
          payerKey: mainKp.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: sendSolTx,
        }).compileToV0Message()
        const transaction = new VersionedTransaction(messageV0)
        transaction.sign([mainKp])
        wallets.map((wallet) => {
          data.push({
            privateKey: base58.encode(wallet.kp.secretKey),
            pubkey: wallet.kp.publicKey.toBase58(),
          })
        })
        const saveResult = saveDataToFile(data)
        if (!saveResult) throw new Error();
        const txSig = await execute(transaction, latestBlockhash, 1)
        const distibuteTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
        console.log("SOL distributed ", distibuteTx)
        break
      } catch (error) {
        index++
      }
    }

    console.log("Success in distribution")
    return wallets
  } catch (error) {
    console.log(`Failed to transfer SOL`)
    return null
  }
}

const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number) => {
  let solBalance: number = 0
  try {
    solBalance = await solanaConnection.getBalance(newWallet.publicKey)
    console.log("🚀 current solBalance:", solBalance / LAMPORTS_PER_SOL)
  } catch (error) {
    console.log("Error getting balance of wallet")
    return null
  }
  if (solBalance == 0) {
    return null
  }
  try {
    let buyTx
    if (SWAP_ROUTING == "RAYDIUM") {
      buyTx = await getBuyTx(solanaConnection, newWallet, baseMint, quoteMint, buyAmount, POOL_ID)
    } else if (SWAP_ROUTING == "JUPITER") {
      buyTx = await getBuyTxWithJupiter(newWallet, baseMint, buyAmount)
    } else if (SWAP_ROUTING == "METEORA") {
      const buyTxHash = await swapOnMeteora(solanaConnection, newWallet, buyAmount, true);
      console.log("🚀 ~ buy ~ buyTxHash:", buyTxHash)
      if (buyTxHash) return `https://solscan.io/tx/${buyTxHash}`;
      else return null;
    } else if (SWAP_ROUTING == "METEORA_DYN") {
      const txHash = await swapOnMeteoraDYN(solanaConnection, new PublicKey(POOL_ID), newWallet, new BN(buyAmount), true);
      const tokenBuyTx = txHash ? `https://solscan.io/tx/${txHash}` : ''
      return tokenBuyTx;
    }
    if (buyTx == null) {
      console.log(`Error getting buy transaction`)
      return null
    }
    const latestBlockhash = await solanaConnection.getLatestBlockhash()
    const txSig = await execute(buyTx, latestBlockhash)
    const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''

    if (tokenBuyTx) {
      const tokenAta = await getAssociatedTokenAddress(baseMint, newWallet.publicKey)
      const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
      if (!tokenBalInfo) {
        console.log("Balance incorrect")
        return null
      }
      const tokenBalance = (tokenBalInfo.value.uiAmount)?.toFixed(2)

    }

    return tokenBuyTx
  } catch (error) {
    return null
  }
}

const sell = async (baseMint: PublicKey, wallet: Keypair) => {
  try {
    const data: Data[] = readJson()
    if (data.length == 0) {
      await sleep(1000)
      return null
    }

    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
    const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
    if (!tokenBalInfo) {
      console.log("Balance incorrect")
      return null
    }
    const tokenBalance = tokenBalInfo.value.uiAmount
    const tokenDecimal = tokenBalInfo.value.decimals
    const remainingAmount = Math.floor(100 * Math.random())
    const sellAmount = tokenBalance! * 10 ** tokenDecimal - remainingAmount

    try {
      if (!tokenBalance) return null

      let sellTx
      if (SWAP_ROUTING == "RAYDIUM") {
        sellTx = await getSellTx(solanaConnection, wallet, baseMint, quoteMint, sellAmount, POOL_ID)
      } else if (SWAP_ROUTING == "JUPITER") {
        sellTx = await getSellTxWithJupiter(wallet, baseMint, sellAmount.toString())
      } else if (SWAP_ROUTING == "METEORA") {
        console.log("🚀 ~ sell ~ sellAmount:", sellAmount)
        const sellTxHash = await swapOnMeteora(solanaConnection, wallet, sellAmount, false);
        console.log("🚀 ~ sell ~ sellTxHash:", sellTxHash)
        if (sellTxHash) return `https://solscan.io/tx/${sellTxHash}`
        else return null;
      } else if (SWAP_ROUTING == "METEORA_DYN") {
        const txHash = await swapOnMeteoraDYN(solanaConnection, new PublicKey(POOL_ID), wallet, new BN(sellAmount), false);
        const tokenSellTx = txHash ? `https://solscan.io/tx/${txHash}` : ''
        return tokenSellTx;
      }

      if (sellTx == null) {
        console.log(`Error getting sell transaction`)
        return null
      }
      // console.log(await solanaConnection.simulateTransaction(sellTx))

      const beforeBalance = await solanaConnection.getBalance(wallet.publicKey)
      const latestBlockhashForSell = await solanaConnection.getLatestBlockhash()
      const txSellSig = await execute(sellTx, latestBlockhashForSell, false)
      const tokenSellTx = txSellSig ? `https://solscan.io/tx/${txSellSig}` : ''
      const afterBalance = await solanaConnection.getBalance(wallet.publicKey)
      const diffBalance = afterBalance - beforeBalance

      //       if (tokenSellTx) {
      //         sendMessage(`🎉 ${WISH_WORD} ${obfuscateString((wallet.publicKey).toString())}
      // 💵 Spent: ${(sellAmount / LAMPORTS_PER_SOL).toFixed(2)} ${TOKEN_NAME}
      // 💎 Got: ${(diffBalance / LAMPORTS_PER_SOL).toFixed(4)} sol ($${(diffBalance * curSolPrice / LAMPORTS_PER_SOL).toFixed(3)})`)
      //       }

      return tokenSellTx
    } catch (error) {
      return null
    }
  } catch (error) {
    return null
  }
}

main()
