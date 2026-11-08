import { afterEach, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { message, messageFixture } from './journal-sql-message.test-fixture'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'

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

it('expires replay during continuous activity even while conversion and sweeps wait for idle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(100)
  const { db, commit, item } = fixture()
  await commit(message('still visible after compaction'))
  const activity = new JournalSqlActivity()
  const pruned = Promise.withResolvers<void>()
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
          if (result && typeof result === 'object' && 'kind' in result && result.deleted) {
            pruned.resolve()
          }
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
  const sweeping = maintenance.requestSweep()
  await vi.advanceTimersByTimeAsync(86400000)
  await pruned.promise
  expect(db.prepare('SELECT sequence FROM journal_events').all()).toEqual([])
  expect(db.prepare('SELECT retained_sequence FROM journal_chat_state').get()).toEqual({
    retained_sequence: 11
  })
  expect(item('orca:assistant')).toMatchObject({
    body: { blocks: [{ type: 'text', text: 'still visible after compaction' }] }
  })
  release()
  await sweeping
})

it('resets old cursors at the replay count and metadata budgets while preserving current content', async () => {
  const { db, commit, item, seedItem } = fixture()
  await commit(message('first'))
  db.exec(`WITH RECURSIVE positions(seq) AS (
    SELECT 12 UNION ALL SELECT seq+1 FROM positions WHERE seq<4106
  ) INSERT INTO journal_events
    SELECT 'chat','epoch',seq,100,(SELECT changes_json FROM journal_events WHERE sequence=11)
    FROM positions;
    UPDATE journal_chat_state SET last_sequence=4106`)
  await commit(message('latest'))
  expect(db.prepare('SELECT retained_sequence FROM journal_chat_state').get()).toEqual({
    retained_sequence: 11
  })
  const after = (sequence: number) =>
    readJournalDomainHistoryPage(db, {
      sessionId: 'chat',
      direction: 'after',
      cursor: { epoch: 'epoch', sequence },
      limit: 1
    })
  expect(after(10)).toMatchObject({
    ok: false,
    reset: 'cursor_compacted',
    page: { items: [{ body: { blocks: [{ text: 'latest' }] } }] }
  })
  expect(after(11).ok).toBe(true)
  seedItem({
    itemId: 'orca:command',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'command', state: 'completed' },
    turnScope: { kind: 'thread' }
  })
  for (let index = 0; index < 300; index++) {
    const messageId = `returned-command-${index}`.padEnd(64, 'x')
    const card = {
      messageId,
      position: index,
      state: 'returned',
      fingerprint: 'command',
      body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } },
      holdReason: null,
      returnedReason: 'refused',
      returnedRejection: null,
      consumedAs: 'command',
      queuedAt: null
    }
    db.prepare(
      `INSERT INTO journal_card_versions(session_id,epoch,message_id,version_sequence,version_index,current,state,command_turn_item_id,payload_json)
        VALUES('chat','epoch',?,1,0,1,'returned','orca:command',?)`
    ).run(messageId, JSON.stringify(card))
  }
  await commit(message('wide withdrawal remains saved'))
  expect(after(4107)).toMatchObject({ ok: false, reset: 'cursor_compacted' })
  expect(item('orca:assistant')).toMatchObject({
    body: { blocks: [{ text: 'wide withdrawal remains saved' }] }
  })
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM journal_card_versions WHERE current=1 AND state='withdrawn'"
      )
      .get()
  ).toEqual({ count: 300 })
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM journal_events').get()!.count
  ).toBeLessThanOrEqual(4096)
  expect(
    db.prepare('SELECT MAX(LENGTH(CAST(changes_json AS BLOB))) AS bytes FROM journal_events').get()!
      .bytes
  ).toBeLessThanOrEqual(16384)
})
