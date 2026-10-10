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

/** Each gap between the main thread's timer turns while `run` ran: how long, and when it ended. */
async function timerGaps(run: () => Promise<unknown>): Promise<{ ms: number; endedAt: number }[]> {
  let last = performance.now()
  const gaps: { ms: number; endedAt: number }[] = []
  const gap = (): void => {
    const now = performance.now()
    gaps.push({ ms: now - last, endedAt: now })
    last = now
  }
  const probe = setInterval(gap, 2)
  try {
    await run()
    gap()
    return gaps
  } finally {
    clearInterval(probe)
  }
}

/** The longest the main thread went without running a timer, while `run` ran. */
export async function longestStall(run: () => Promise<unknown>): Promise<number> {
  return Math.max(0, ...(await timerGaps(run)).map((gap) => gap.ms))
}

/** Every time the main thread went longer than `ms` without running a timer, while `run` ran. */
export async function stallsOver(
  ms: number,
  run: () => Promise<unknown>
): Promise<{ ms: number; endedAt: number }[]> {
  return (await timerGaps(run)).filter((gap) => gap.ms > ms)
}
