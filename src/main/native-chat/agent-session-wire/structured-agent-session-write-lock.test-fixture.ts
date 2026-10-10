// Another connection's write lock, held from its own thread, and a watch on the main thread while
// this one meets it: for tests of bookkeeping that must fail at once instead of waiting it out.

import { Worker } from 'node:worker_threads'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'

const lockers = new Set<Worker>()

/** Another connection, on its own thread, holds the write lock for `ms`: this thread's waits
 *  cannot release it, as another process's could not. Resolves once the lock is held. */
export function holdWriteLock(
  stateDirectory: string,
  ms: number
): Promise<{ released: Promise<void> }> {
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads')
     const { DatabaseSync } = require('node:sqlite')
     const db = new DatabaseSync(workerData.file)
     db.exec('BEGIN IMMEDIATE')
     parentPort.postMessage('locked')
     setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released') }, workerData.ms)`,
    { eval: true, workerData: { file: journalDatabasePath(stateDirectory), ms } }
  )
  lockers.add(worker)
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => (release = resolve))
  return new Promise((resolve) =>
    worker.on('message', (message) => (message === 'locked' ? resolve({ released }) : release()))
  )
}

/** Ends every lock a test still holds. */
export async function releaseWriteLocks(): Promise<void> {
  await Promise.all([...lockers].map((worker) => worker.terminate()))
  lockers.clear()
}

/** The longest the main thread went without running a timer, while `run` ran. */
export async function longestStall(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const probe = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 2)
  try {
    await run()
    return Math.max(longest, performance.now() - last)
  } finally {
    clearInterval(probe)
  }
}
