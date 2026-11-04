import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import {
  observeNativeJournalSql,
  type NativeJournalSqlObservation
} from './journal-native-test-instrumentation'

let root: string
afterEach(async () => {
  await closeTestJournalHostDatabases()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([10, 1000])(
  'bounds native mutation work independently of %i retained sessions',
  async (history) => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-scaling-'))
    const database = await openTestJournalHostDatabase(root)
    await database.transaction((plan) => {
      for (let index = 0; index < history; index++) {
        publishTestJournalEpoch(plan, `retained-${index}`, `epoch-${index}`)
      }
    })
    const observations: NativeJournalSqlObservation[] = []
    const stop = observeNativeJournalSql(database, (entry) => observations.push(entry))
    try {
      const writes = Array.from({ length: 10 }, (_, index) =>
        database.transaction((plan) => {
          publishTestJournalEpoch(plan, `new-${index}`, `new-epoch-${index}`)
        })
      )
      await Promise.all(writes)
    } finally {
      stop()
    }
    expect(
      observations.filter((entry) => entry.method === 'exec' && entry.sql === 'BEGIN IMMEDIATE')
    ).toHaveLength(10)
    expect(
      observations.filter((entry) => entry.method === 'exec' && entry.sql === 'COMMIT')
    ).toHaveLength(10)
    // Mutation reads are keyed by session; no retained-history scan or checkpoint job accompanies them.
    const reads = observations.filter(
      (entry) => entry.method === 'all' || entry.method === 'get' || entry.method === 'row'
    )
    expect(reads.every((entry) => entry.rows <= 1)).toBe(true)
    expect(reads.length).toBeLessThanOrEqual(30)
    expect(observations.some((entry) => /wal_checkpoint|VACUUM/i.test(entry.sql))).toBe(false)
    expect(
      (
        await database.read((read) =>
          read.prepare('SELECT count(*) AS n FROM journal_sessions').get()
        )
      )?.n
    ).toBe(history + 10)
  }
)
