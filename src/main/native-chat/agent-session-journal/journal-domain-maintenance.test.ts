import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { messageFixture } from './journal-sql-message.test-fixture'
import { applyJournalSqlMaintenance, type JournalSqlMaintenance } from './journal-sql-maintenance'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('auto_vacuum=INCREMENTAL')
  messageFixture(db)
  return db
}

function maintain(db: Database.Database, operation: JournalSqlMaintenance) {
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

it('prunes proven retired epochs with atomic rollback while preserving incomplete imports and current anchors', () => {
  const db = fixture()
  for (const [sessionId, epoch] of [
    ['chat', 'before'],
    ['chat', 'later'],
    ['chat', 'epoch'],
    ['incomplete', 'epoch'],
    ['failed', 'epoch']
  ]) {
    const prefix = [sessionId, epoch]
    db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,
      sequence_index,owner_fence,payload_json) VALUES(?,?,'body',1,1,1,0,1,'{"text":"saved body"}')`).run(
      ...prefix
    )
    db.prepare(`INSERT INTO journal_item_tombstones VALUES(?,?,'deleted',1)`).run(...prefix)
    db.prepare(`INSERT INTO journal_item_aliases VALUES(?,?,'provider','body',0,NULL)`).run(
      ...prefix
    )
    db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
      attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,payload_json)
      VALUES(?,?,'send',1,0,1,'body',1,1,'fingerprint','accepted','accepted body')`).run(...prefix)
    db.prepare(`INSERT INTO journal_send_receipts VALUES(?,?,'send','accepted receipt')`).run(
      ...prefix
    )
    db.prepare(
      `INSERT INTO journal_queue_cards VALUES(?,?,'queued',1,'waiting',1,NULL,'domain body')`
    ).run(...prefix)
    db.prepare(
      `INSERT INTO journal_edit_leases VALUES(?,?,'owner','caller','edit','queued',1,100)`
    ).run(...prefix)
    db.prepare(`INSERT INTO journal_provider_activity VALUES(?,?,1,100)`).run(...prefix)
    db.prepare(`INSERT INTO journal_events VALUES(?,?,1,100,'{}')`).run(...prefix)
  }
  db.exec(`INSERT INTO agent_session_records VALUES('chat','saved record');
    INSERT INTO agent_session_tabs VALUES('tab','chat',1)`)
  db.exec('BEGIN IMMEDIATE')
  applyJournalSqlMaintenance(db, { kind: 'domain-retired-prune' })
  applyJournalSqlMaintenance(db, { kind: 'compaction-complete', now: 200 })
  db.exec('ROLLBACK')
  expect(
    db
      .prepare("SELECT payload_json FROM journal_items WHERE session_id='chat' AND epoch='before'")
      .get()
  ).toEqual({ payload_json: '{"text":"saved body"}' })
  expect(maintain(db, { kind: 'compaction-state' })).toEqual({
    kind: 'compaction-state',
    completedAt: null
  })
  let more = true
  while (more) {
    const result = maintain(db, { kind: 'domain-retired-prune' })
    if (!result || typeof result !== 'object' || !('more' in result)) {
      throw new Error('expected page')
    }
    more = result.more
  }
  expect(
    db.prepare('SELECT session_id,epoch,payload_json FROM journal_items ORDER BY session_id').all()
  ).toEqual([
    { session_id: 'chat', epoch: 'epoch', payload_json: '{"text":"saved body"}' },
    { session_id: 'failed', epoch: 'epoch', payload_json: '{"text":"saved body"}' },
    { session_id: 'incomplete', epoch: 'epoch', payload_json: '{"text":"saved body"}' }
  ])
  expect(
    db.prepare("SELECT payload_json FROM journal_send_receipts WHERE session_id='chat'").all()
  ).toEqual([{ payload_json: 'accepted receipt' }])
  expect(
    db.prepare("SELECT payload_json FROM journal_submission_attempts WHERE session_id='chat'").all()
  ).toEqual([{ payload_json: 'accepted body' }])
  expect(db.prepare('SELECT record_json FROM agent_session_records').get()).toEqual({
    record_json: 'saved record'
  })
  expect(db.prepare('SELECT tab_id,session_id,position FROM agent_session_tabs').get()).toEqual({
    tab_id: 'tab',
    session_id: 'chat',
    position: 1
  })
  maintain(db, { kind: 'compaction-complete', now: 200 })
  expect(maintain(db, { kind: 'compaction-state' })).toEqual({
    kind: 'compaction-state',
    completedAt: 200
  })
})

it('returns a free page inside the writer transaction and restores it on rollback', () => {
  const db = fixture()
  db.exec(`CREATE TABLE reclaim_fixture(payload BLOB);
    INSERT INTO reclaim_fixture VALUES(zeroblob(65536));
    DELETE FROM reclaim_fixture`)
  const pages = () => Number(db.pragma('page_count', { simple: true }))
  const before = pages()
  db.exec('BEGIN IMMEDIATE')
  applyJournalSqlMaintenance(db, { kind: 'page-reclaim' })
  expect(pages()).toBeLessThan(before)
  db.exec('ROLLBACK')
  expect(pages()).toBe(before)
  maintain(db, { kind: 'page-reclaim' })
  expect(pages()).toBeLessThan(before)
})
