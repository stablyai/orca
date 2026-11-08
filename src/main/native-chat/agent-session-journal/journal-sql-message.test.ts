import { afterEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import { commitJournalSqlMessages, prepareJournalSqlMessages } from './journal-sql-message-commit'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

const databases: Database.Database[] = []
const fixture = () => {
  const value = messageFixture()
  databases.push(value.db)
  return value
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('reroutes a first snapshot to FULL and publishes exact committed revisions in order', async () => {
  const { db, batch, commit, item, published } = fixture()
  db.exec(`CREATE TEMP TRIGGER durable_first BEFORE INSERT ON journal_items
    WHEN (SELECT synchronous FROM pragma_synchronous)<>2 BEGIN SELECT RAISE(ABORT,'creation was not FULL'); END`)
  expect((await commit(message('first'))).outcomes[0]).toMatchObject({
    committed: true,
    value: {
      cursor: { epoch: 'epoch', sequence: 11 }
    }
  })
  db.exec('DROP TRIGGER durable_first')
  const result = await commitJournalSqlMessages(
    db,
    batch,
    ['second', 'third'].map((text) =>
      prepareJournalSqlMessages({ target, steps: [message(text)], savedAt: 200 })
    ),
    (result) => published.push(result)
  )
  expect(result.outcomes.map((entry) => entry.committed)).toEqual([true, true])
  expect(published.map((entry) => entry.items[0]?.body)).toEqual([
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'second' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'third' }] }
  ])
  expect(item('orca:assistant')).toMatchObject({ revision: 3, sequence: 11, observedAt: 100 })
  db.exec(`CREATE TEMP TRIGGER durable_message_end BEFORE UPDATE ON journal_items
    WHEN (SELECT synchronous FROM pragma_synchronous)<>2 AND json_extract(NEW.payload_json,'$.body.completedAt') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'message end was not FULL'); END`)
  const ended = message('third')
  ended.body.completedAt = 300
  expect((await commit(ended)).outcomes[0]).toMatchObject({
    committed: true,
    value: {
      cursor: { epoch: 'epoch', sequence: 14 },
      items: [{ body: { completedAt: 300 } }]
    }
  })
  expect(db.pragma('user_version', { simple: true })).toBe(4)
})

it('commits ready revisions from different chats atomically before publishing either payload', async () => {
  const { db, batch, commit } = fixture()
  await commit(message('first', 'assistant', 'item'))
  db.exec(`INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence)
    VALUES('other','epoch',0,1)`)
  const other = { sessionId: 'other', epoch: 'epoch' }
  await commitJournalSqlMessages(
    db,
    batch,
    [
      prepareJournalSqlMessages({
        target: other,
        steps: [message('other first', 'assistant', 'item')],
        savedAt: 100
      })
    ],
    () => {}
  )
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE published_pair (id TEXT PRIMARY KEY);
    CREATE TABLE pending_pair (id TEXT REFERENCES published_pair(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER pair_first AFTER UPDATE ON journal_items WHEN NEW.session_id='chat'
      BEGIN INSERT INTO pending_pair VALUES ('paired'); END;
    CREATE TEMP TRIGGER pair_second AFTER UPDATE ON journal_items WHEN NEW.session_id='other'
      BEGIN INSERT INTO published_pair VALUES ('paired'); END`)
  const delivered: string[] = []
  const result = await commitJournalSqlMessages(
    db,
    batch,
    [target, other].map((target) =>
      prepareJournalSqlMessages({ target, steps: [message('last')], savedAt: 200 })
    ),
    (commit, index) => {
      expect(db.isTransaction).toBe(false)
      expect(db.prepare('SELECT id FROM published_pair').get()).toEqual({ id: 'paired' })
      delivered.push(`${index}:${commit.cursor.sequence}`)
    }
  )
  expect(result.outcomes.map((outcome) => outcome.committed)).toEqual([true, true])
  expect(delivered).toEqual(['0:12', '1:2'])
})

it('accepts an optimistic echo once, preserving its local body and moved placement', async () => {
  const { db, commit, item, seedSend, seedItem } = fixture()
  seedSend()
  db.exec(`INSERT INTO journal_submission_attempts
    SELECT session_id,epoch,message_id,0,0,0,item_id,0,0,NULL,fingerprint,'unknown',0,NULL,NULL,payload_json
    FROM journal_submission_attempts WHERE current=1`)
  const historical = db
    .prepare('SELECT payload_json FROM journal_submission_attempts WHERE current=0')
    .get()!.payload_json
  seedItem({
    itemId: 'orca:reported-command',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 'command', state: 'completed' },
    turnScope: { kind: 'thread' }
  })
  const card = {
    messageId: 'card',
    position: 1,
    body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } },
    fingerprint: 'card',
    state: 'returned',
    holdReason: null,
    returnedReason: 'refused',
    returnedRejection: null,
    consumedAs: 'command',
    queuedAt: null
  }
  db.prepare(
    `INSERT INTO journal_card_versions(session_id,epoch,message_id,version_sequence,version_index,current,state,command_turn_item_id,payload_json)
      VALUES('chat','epoch','card',1,0,1,'returned','orca:reported-command',?)`
  ).run(JSON.stringify(card))
  db.exec(`CREATE TEMP TRIGGER durable_echo BEFORE UPDATE ON journal_submission_attempts
    WHEN (SELECT synchronous FROM pragma_synchronous)<>2 BEGIN SELECT RAISE(ABORT,'acceptance was not FULL'); END`)
  const input = message('original', 'unused', 'item')
  input.identity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }
  input.body.role = 'user'
  const answer = await commit(input)
  expect(answer.outcomes[0]).toMatchObject({
    committed: true,
    value: {
      inputChanged: true,
      acceptedInputs: { latestAcceptedTurnSequence: 1, latestPersonAcceptedSequence: 1 },
      cards: [{ messageId: 'card', state: 'withdrawn' }],
      receipts: [
        { clientMessageId: 'send', acceptedAt: 100, cursor: { epoch: 'epoch', sequence: 11 } }
      ]
    }
  })
  const accepted: AgentJournalSubmission = JSON.parse(
    String(
      db.prepare('SELECT payload_json FROM journal_submission_attempts WHERE current=1').get()!
        .payload_json
    )
  )
  expect(accepted).toMatchObject({
    fence: 1,
    dispatchState: 'accepted',
    reason: null,
    resolvedAt: 100,
    acceptedSequence: 1
  })
  expect(accepted).not.toHaveProperty('recovered')
  expect(
    db.prepare('SELECT payload_json FROM journal_submission_attempts WHERE current=0').get()!
      .payload_json
  ).toBe(historical)
  expect(
    db.prepare('SELECT payload_json FROM journal_card_versions WHERE current=0').get()
  ).toBeUndefined()
  expect(
    db.prepare('SELECT candidate FROM journal_submission_attempts WHERE current=1').get()!.candidate
  ).toBe(0)
  expect(item('orca:send')).toMatchObject({
    sequence: 7,
    observedAt: 70,
    body: { blocks: [{ type: 'text', text: 'original' }] }
  })
  input.body.blocks = [{ type: 'text', text: 'provider normalized' }]
  expect((await commit(input)).outcomes[0]).toMatchObject({
    committed: true,
    value: { receipts: [], inputChanged: false }
  })
  expect(item('orca:send')?.body).toEqual({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'original' }]
  })
  expect(db.prepare('SELECT COUNT(*) AS count FROM journal_items').get()!.count).toBe(2)
})

it('refuses a snapshot after the saved turn ends and commits only a successful step prefix', async () => {
  const { db, commit, item, seedItem } = fixture()
  seedItem({
    itemId: 'orca:turn',
    revision: 3,
    sequence: 3,
    observedAt: 30,
    body: { kind: 'turn', turnId: 'turn', state: 'completed', startedAt: 1, completedAt: 2 },
    turnScope: { kind: 'thread' }
  })
  const late = message('late')
  late.options.turnScope = { kind: 'turn', turnItemId: 'orca:turn' }
  expect((await commit(late)).outcomes[0]).toMatchObject({
    committed: true,
    value: {
      cursor: { epoch: 'epoch', sequence: 10 },
      items: [],
      outcomes: [{ kind: 'dropped', reason: 'turn-settled' }]
    }
  })
  expect(item('orca:assistant')).toBeUndefined()
  db.exec(`CREATE TEMP TRIGGER fail_message BEFORE INSERT ON journal_items WHEN NEW.item_id='orca:refused'
    BEGIN SELECT RAISE(ABORT,'refused'); END`)
  expect(
    (
      await commit(
        message('prefix', 'prefix', 'item'),
        message('bad', 'refused', 'item'),
        message('suffix', 'suffix', 'item')
      )
    ).outcomes[0]
  ).toMatchObject({
    committed: true,
    value: {
      cursor: { epoch: 'epoch', sequence: 11 },
      items: [{ itemId: 'orca:prefix' }],
      failure: { message: 'refused' }
    }
  })
  expect(item('orca:refused')).toBeUndefined()
  expect(item('orca:suffix')).toBeUndefined()
  expect(db.prepare('SELECT COUNT(*) AS count FROM journal_events').get()!.count).toBe(1)
})

it('stores one growing text body and a metadata-only replay tail', async () => {
  const { db, commit } = fixture()
  for (let revision = 1; revision <= 100; revision++) {
    await commit(message('x'.repeat(revision * 1024)))
  }
  const bodyBytes = Number(
    db.prepare('SELECT SUM(LENGTH(payload_json)) AS bytes FROM journal_items').get()!.bytes
  )
  const tailBytes = Number(
    db.prepare('SELECT SUM(LENGTH(changes_json)) AS bytes FROM journal_events').get()!.bytes
  )
  // 100KiB current body plus at most 256 bytes of identity/placement per flush.
  expect(bodyBytes + tailBytes).toBeLessThan(100 * 1024 + 100 * 256)
  expect(
    db.prepare("SELECT 1 FROM journal_events WHERE changes_json LIKE '%xxxxxxxx%' LIMIT 1").get()
  ).toBeUndefined()
})
