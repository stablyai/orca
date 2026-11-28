import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setEnvironmentData } from 'node:worker_threads'
import { JournalSqlOwner } from './journal-sql-owner'
import { journalSqlWorkerPath } from './journal-sql-worker-bundle.test-fixture'

const barrierKey = 'journal-retirement-commit-test'

export function openJournalWithCommitBarrier(filename: string, root: string) {
  const entry = join(root, 'writer-with-barrier.cjs')
  writeFileSync(
    entry,
    `
const { DatabaseSync } = require('node:sqlite')
const { getEnvironmentData } = require('node:worker_threads')
const barrier = getEnvironmentData(${JSON.stringify(barrierKey)})
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.exec = function (sql) {
  const result = exec.call(this, sql)
  if (sql === 'RELEASE journal_command' && Atomics.compareExchange(barrier, 0, 1, 0) === 1) {
    Atomics.store(barrier, 1, 1)
    Atomics.notify(barrier, 1)
    if (Atomics.wait(barrier, 2, 0, 5000) === 'timed-out') {
      throw new Error('journal commit test did not release the worker')
    }
  }
  return result
}
require(${JSON.stringify(journalSqlWorkerPath())})
`
  )
  const barrier = new Int32Array(new SharedArrayBuffer(12))
  setEnvironmentData(barrierKey, barrier)
  let writer: JournalSqlOwner
  try {
    writer = new JournalSqlOwner(filename, root, entry)
  } finally {
    setEnvironmentData(barrierKey, undefined)
  }
  return {
    writer,
    arm: () => Atomics.store(barrier, 0, 1),
    reached: async () => {
      const wait = Atomics.waitAsync(barrier, 1, 0, 4000)
      if ((await wait.value) === 'timed-out') {
        throw new Error('journal worker did not reach the commit barrier')
      }
    },
    release: () => {
      Atomics.store(barrier, 2, 1)
      Atomics.notify(barrier, 2)
    }
  }
}
