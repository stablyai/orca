import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { readWorkerSendLedger } from './worker-send-ledger'
import { spawnWorkerThread } from './worker-thread-spawn'

const loader = createRequire(import.meta.url).resolve('tsx/cjs')
const ledger = resolve('src/main/worker-threads/worker-send-ledger.ts')

function spawnSender(): ReturnType<typeof spawnWorkerThread> {
  return spawnWorkerThread(
    `require(${JSON.stringify(loader)})
    const { installWorkerSendLedger } = require(${JSON.stringify(ledger)})
    const { parentPort } = require('node:worker_threads')
    installWorkerSendLedger('orca-journal-sql-reader')
    parentPort.postMessage({ type: 'history-page', rows: new Array(300).fill('x') })
    parentPort.once('message', () => process.exit(0))`,
    { name: 'orca-journal-sql-reader', eval: true, execArgv: ['--conditions=orca-source'] }
  )
}

describe('worker send ledger', () => {
  it('names the sender of the last message before main reads it, and frees the slot on exit', async () => {
    const worker = spawnSender()
    const [message] = await once(worker, 'message')
    expect(message.type).toBe('history-page')

    const entry = readWorkerSendLedger().find((slot) => slot.threadId === worker.threadId)
    expect(entry).toMatchObject({
      role: 'orca-journal-sql-reader',
      sends: 1,
      lastKind: 'history-page',
      lastItems: 300,
      maxKind: 'history-page'
    })

    const threadId = worker.threadId
    worker.postMessage('stop')
    await once(worker, 'exit')
    expect(readWorkerSendLedger().some((slot) => slot.threadId === threadId)).toBe(false)
  })
})
