import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setEnvironmentData } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'

const REPLY_BYTES = 256 * 1024
const SESSIONS = 200
const COUNTERS_KEY = 'orca.test.journal-reader-counters'

let root: string
let pool: JournalSqlReaderPool | undefined
/** [requests the workers received, replies they posted, held reads released] */
let counters: Int32Array

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-reader-admission-'))
  const shared = new SharedArrayBuffer(12)
  counters = new Int32Array(shared)
  setEnvironmentData(COUNTERS_KEY, shared)
})

afterEach(async () => {
  await pool?.close()
  pool = undefined
  await rm(root, { recursive: true, force: true })
})

async function openPool(): Promise<JournalSqlReaderPool> {
  const workerPath = join(root, 'history-reader.cjs')
  await writeFile(
    workerPath,
    `const { parentPort, getEnvironmentData } = require('node:worker_threads')
const counters = new Int32Array(getEnvironmentData(${JSON.stringify(COUNTERS_KEY)}))
parentPort.on('message', ({ id, operation }) => {
  Atomics.add(counters, 0, 1)
  if (operation.request.sessionId.startsWith('hold-')) Atomics.wait(counters, 2, 0)
  parentPort.postMessage({ type: 'page', id, result: { text: String(id).padEnd(${REPLY_BYTES}, 'x') } })
  Atomics.add(counters, 1, 1)
})
parentPort.postMessage({ type: 'ready' })`
  )
  pool = new JournalSqlReaderPool(join(root, 'journal.db'), join(root, 'journal.db'), workerPath)
  return pool
}

function read(readers: JournalSqlReaderPool, sessionId: string, signal?: AbortSignal) {
  return readers.domainHistoryFrame(
    { sessionId, direction: 'tail', reader: { form: 'client', budgetBytes: REPLY_BYTES } },
    undefined,
    signal
  )
}

/** Main is busy (rendering, a long task) while the workers keep answering. */
function blockMain(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

it('keeps replies main has not consumed bounded while main is too busy to take them', async () => {
  const readers = await openPool()
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => read(readers, id)))
  const warm = Atomics.load(counters, 1)
  let consumed = 0
  const reads = Array.from({ length: SESSIONS }, (_, index) =>
    read(readers, `session-${index}`).then(() => {
      consumed += 1
    })
  )
  let maxUnconsumedBytes = 0
  while (consumed < SESSIONS) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    blockMain(25)
    const produced = Atomics.load(counters, 1) - warm
    maxUnconsumedBytes = Math.max(maxUnconsumedBytes, (produced - consumed) * REPLY_BYTES)
  }
  await Promise.all(reads)
  // Eight admitted reads of 256 KB; without admission all 200 replies (50 MB) pile up.
  expect(maxUnconsumedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
})

it('withdraws waiting reads whose reader stopped before a worker took them', async () => {
  const readers = await openPool()
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => read(readers, id)))
  const held = Array.from({ length: 8 }, (_, index) => read(readers, `hold-${index}`))
  const stopped = new AbortController()
  const kept = Array.from({ length: 10 }, (_, index) => read(readers, `kept-${index}`))
  const obsolete = Array.from({ length: 20 }, (_, index) =>
    read(readers, `obsolete-${index}`, stopped.signal)
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  stopped.abort()
  Atomics.store(counters, 2, 1)
  Atomics.notify(counters, 2)
  const settled = await Promise.allSettled([...held, ...kept, ...obsolete])
  expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(20)
  // 4 warm-up reads, 8 held, 10 kept; none of the obsolete reads reached a worker.
  expect(Atomics.load(counters, 0)).toBe(22)
})
