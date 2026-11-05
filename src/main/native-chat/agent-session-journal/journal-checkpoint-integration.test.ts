import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath, type JournalHostDatabase } from './journal-host-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import {
  failNextNativeJournalStatement,
  observeNativeJournalTransactions
} from './journal-native-test-instrumentation'

let root: string
let database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-maintenance-'))
  database = await openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
  'retains scoped streamed durability for streamed=%s and survives maintenance/reopen',
  async (streamed) => {
    const commits: { synchronous: number }[] = []
    const stop = observeNativeJournalTransactions(database, (transaction) => {
      if (transaction.sql === 'COMMIT') {
        commits.push(transaction)
      }
    })
    let adopted = false
    try {
      await database.transaction(
        (plan) => {
          publishTestJournalEpoch(plan, 'session-1', 'epoch-1')
        },
        streamed,
        () => {
          adopted = true
        }
      )
      expect(adopted).toBe(true)
      expect(commits).toEqual([{ sql: 'COMMIT', rowInserts: 0, synchronous: streamed ? 1 : 2 }])
      expect(await database.read((read) => read.prepare('PRAGMA journal_mode').get())).toEqual({
        journal_mode: 'wal'
      })
      await database.maintenance({ kind: 'retired', after: 0 })
    } finally {
      stop()
    }
    await database.close()
    database = await openTestJournalHostDatabase(root)
    expect(
      await database.read((read) =>
        read.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get('session-1')
      )
    ).toEqual({ epoch: 'epoch-1' })
    expect(await database.read((read) => read.prepare('PRAGMA quick_check').get())).toEqual({
      quick_check: 'ok'
    })
  }
)

it('does not revoke an adopted write when a later maintenance job rolls back', async () => {
  let adopted = 0
  await database.transaction(
    (plan) => {
      publishTestJournalEpoch(plan, 'session-1', 'epoch-1')
    },
    false,
    () => {
      adopted++
    }
  )
  await failNextNativeJournalStatement(database, 'COMMIT', 'maintenance commit refused')
  await expect(database.maintenance({ kind: 'retired', after: 0 })).rejects.toThrow(
    'maintenance commit refused'
  )
  expect(adopted).toBe(1)
  expect(database.isFaulted).toBe(false)
  await database.transaction((plan) => {
    publishTestJournalEpoch(plan, 'session-2', 'epoch-2')
  })
  expect(
    await database.read((read) =>
      read.prepare('SELECT session_id FROM journal_sessions ORDER BY session_id').all()
    )
  ).toEqual([{ session_id: 'session-1' }, { session_id: 'session-2' }])
})

it('adopts a known commit and retires its owner when restoring FULL fails', async () => {
  await failNextNativeJournalStatement(database, 'PRAGMA synchronous = FULL', 'restore failed')
  let adopted = false
  await expect(
    database.transaction(
      (plan) => publishTestJournalEpoch(plan, 'committed', 'epoch-committed'),
      true,
      () => {
        adopted = true
      }
    )
  ).rejects.toMatchObject({ outcome: 'committed' })
  expect(adopted).toBe(true)
  expect(database.isFaulted).toBe(true)
  await expect(
    database.transaction((plan) => publishTestJournalEpoch(plan, 'not-admitted', 'epoch-next'))
  ).rejects.toThrow()
  await database.close()
  database = await openTestJournalHostDatabase(root)
  expect(
    await database.read((read) =>
      read.prepare('SELECT session_id, epoch FROM journal_sessions ORDER BY session_id').all()
    )
  ).toEqual([{ session_id: 'committed', epoch: 'epoch-committed' }])
})

it('checkpoints an idle tail after its reader releases and closes every WAL handle before reopen', async () => {
  const json = JSON.stringify({ text: 'saved'.repeat(40_000) })
  await database.transaction((plan) => publishTestJournalEpoch(plan, 'checkpoint', 'epoch'))
  const append = (seq: number) =>
    database.transaction((plan) => {
      plan.add({
        kind: 'rows',
        sessionId: 'checkpoint',
        rows: [{ epoch: 'epoch', seq, json, savedAt: 1 }]
      })
    })
  await append(1)
  const lease = await database.snapshot(() => undefined)
  const inspect = new Database(journalDatabasePath(root))
  try {
    await append(2)
    await append(3)
    const pinned = inspect.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
    expect(Number(pinned.log)).toBeGreaterThan(Number(pinned.checkpointed))
    await lease.close()
    await vi.waitFor(
      () => {
        const idle = inspect.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
        expect(idle.log).toBe(idle.checkpointed)
      },
      { timeout: 3000 }
    )
  } finally {
    await lease.close()
    inspect.close()
  }
  await database.close()
  await expect(stat(`${journalDatabasePath(root)}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
  database = await openTestJournalHostDatabase(root)
  expect(
    await database.read((read) =>
      read
        .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY seq')
        .all('checkpoint')
    )
  ).toEqual([{ row_json: json }, { row_json: json }, { row_json: json }])
})

it('does not admit maintenance or mutations on a newer read-only journal', async () => {
  await database.close()
  const fixture = new Database(journalDatabasePath(root))
  try {
    fixture.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
  } finally {
    fixture.close()
  }
  database = await openTestJournalHostDatabase(root)
  expect(database.readOnly).toBe(true)
  await expect(database.maintenance({ kind: 'retired', after: 0 })).rejects.toMatchObject({
    code: 'journal_read_only'
  })
  await expect(
    database.transaction((plan) => {
      publishTestJournalEpoch(plan, 'session-1', 'epoch-1')
    })
  ).rejects.toMatchObject({ code: 'journal_read_only' })
  expect(
    await database.read((read) => read.prepare('SELECT session_id FROM journal_sessions').all())
  ).toEqual([])
})
