import { afterEach, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { message, messageFixture } from './journal-sql-message.test-fixture'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'

const databases: Database.Database[] = []
const maintainers: JournalSqlBackgroundMaintenance[] = []
afterEach(async () => {
  for (const maintenance of maintainers.splice(0)) {
    maintenance.stop()
    await maintenance.settled()
  }
  vi.useRealTimers()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const fixture = () => {
  const value = messageFixture()
  databases.push(value.db)
  return value
}

it('compacts expired replay holes atomically while retaining current bodies, receipts and younger events', async () => {
  const { db, commit, item } = fixture()
  await commit(message('the current body'))
  db.exec(`INSERT INTO journal_send_receipts VALUES('chat','epoch','accepted','{"acceptedAt":100}');
    UPDATE journal_chat_state SET last_sequence=65;
    INSERT INTO journal_events VALUES('chat','epoch',12,86400000,'{}')`)
  const insert = db.prepare(`INSERT INTO journal_events VALUES('chat','epoch',?,100,'{}')`)
  for (let sequence = 13; sequence <= 65; sequence++) {
    insert.run(sequence)
  }
  const retained = () =>
    db.prepare('SELECT retained_sequence FROM journal_chat_state').get()!.retained_sequence
  db.exec('BEGIN IMMEDIATE')
  applyJournalSqlMaintenance(db, { kind: 'event-tail-prune', now: 86400100 })
  db.exec('ROLLBACK')
  expect(retained()).toBe(0)
  expect(db.prepare('SELECT sequence FROM journal_events WHERE sequence=11').get()).toEqual({
    sequence: 11
  })
  let nextDueAt: number | null = 0
  while (nextDueAt !== null && nextDueAt <= 86400100) {
    db.exec('BEGIN IMMEDIATE')
    const result = applyJournalSqlMaintenance(db, { kind: 'event-tail-prune', now: 86400100 })
    db.exec('COMMIT')
    if (!result || typeof result !== 'object' || !('kind' in result)) {
      throw new Error('expected event-tail result')
    }
    nextDueAt = result.nextDueAt
  }
  expect(retained()).toBe(65)
  expect(db.prepare('SELECT sequence FROM journal_events').all()).toEqual([{ sequence: 12 }])
  expect(nextDueAt).toBe(172800000)
  expect(item('orca:assistant')).toMatchObject({
    revision: 1,
    body: { blocks: [{ type: 'text', text: 'the current body' }] }
  })
  expect(db.prepare('SELECT payload_json FROM journal_send_receipts').get()).toEqual({
    payload_json: '{"acceptedAt":100}'
  })
})

it('expires a settled chat through the same idle maintenance lane without another chat write', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(100)
  const { db, commit, item } = fixture()
  await commit(message('still visible after compaction'))
  const activity = new JournalSqlActivity()
  const maintenance = new JournalSqlBackgroundMaintenance(
    {
      maintain: async (operation) => {
        if (operation.kind === 'projection-sweep') {
          return false
        }
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = applyJournalSqlMaintenance(db, operation)
          db.exec('COMMIT')
          return result
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
    },
    { database: async () => ({ kind: 'sessions', sessionIds: [] }) },
    { ensure: async () => null },
    activity,
    (error) => {
      throw error
    }
  )
  maintainers.push(maintenance)
  await maintenance.start()
  const release = activity.hold()
  await vi.advanceTimersByTimeAsync(86400000)
  expect(db.prepare('SELECT sequence FROM journal_events').all()).toEqual([{ sequence: 11 }])
  release()
  await maintenance.settled()
  expect(db.prepare('SELECT sequence FROM journal_events').all()).toEqual([])
  expect(db.prepare('SELECT retained_sequence FROM journal_chat_state').get()).toEqual({
    retained_sequence: 11
  })
  expect(item('orca:assistant')).toMatchObject({
    body: { blocks: [{ type: 'text', text: 'still visible after compaction' }] }
  })
})
