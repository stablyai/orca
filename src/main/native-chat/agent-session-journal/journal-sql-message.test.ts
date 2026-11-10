import { afterEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainItemPlacement } from './journal-domain-item-placement'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainItems } from './journal-sql-item-reads'

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

it('rejects unreadable metadata in an existing text snapshot without changing saved text', async () => {
  const { commit, item } = fixture()
  await commit(message('Saved'))
  const invalid = message('Unreadable')
  invalid.body.completedAt = Number.NaN
  expect((await commit(invalid)).outcomes[0]).toMatchObject({
    committed: true,
    value: { value: { failure: { code: 'journal_row_rejected' } } }
  })
  expect(item('orca:assistant')).toMatchObject({
    revision: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Saved' }] }
  })
})

it('publishes exact committed snapshots and their final body in order', async () => {
  const { db, command, commitCommands, commit, item, published } = fixture()
  db.prepare('UPDATE journal_chat_state SET context_boundary=7').run()
  expect((await commit(message('first'))).outcomes[0]).toMatchObject({
    committed: true,
    value: {
      cursor: {
        epoch: 'context-v1:2aa4945736094af6247b635644bf6763d06f6ba2c1f8d5a69f5ef000feafd5f1',
        sequence: 11
      }
    }
  })
  const result = await commitCommands(
    ['second', 'third'].map((text) => command([message(text)])),
    200
  )
  expect(result.outcomes.map((entry) => entry.committed)).toEqual([true, true])
  expect(published.at(-1)?.cursor).toEqual({
    epoch: 'context-v1:2aa4945736094af6247b635644bf6763d06f6ba2c1f8d5a69f5ef000feafd5f1',
    sequence: 13
  })
  expect(published.map((entry) => entry.publication?.items[0]?.body)).toEqual([
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'second' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'third' }] }
  ])
  expect(item('orca:assistant')).toMatchObject({ revision: 3, sequence: 11, observedAt: 100 })
  const ended = message('third')
  ended.body.completedAt = 300
  expect((await commit(ended)).outcomes[0]).toMatchObject({
    committed: true,
    value: {
      cursor: {
        epoch: 'context-v1:2aa4945736094af6247b635644bf6763d06f6ba2c1f8d5a69f5ef000feafd5f1',
        sequence: 14
      },
      publication: { items: [{ body: { completedAt: 300 } }] }
    }
  })
})

it('commits ready revisions from different chats atomically', async () => {
  const { db, command, commitCommands, commit } = fixture()
  await commit(message('first', 'assistant', 'item'))
  db.exec(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
    VALUES('workspace','other','epoch',0,1)`)
  const other = { sessionId: 'other', epoch: 'epoch', ownerToken: 'other-owner' }
  await commitCommands([command([message('other first', 'assistant', 'item')], other)])
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE published_pair (id TEXT PRIMARY KEY);
    CREATE TABLE pending_pair (id TEXT REFERENCES published_pair(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER pair_first AFTER UPDATE OF payload_json ON journal_items WHEN NEW.session_id='chat'
      BEGIN INSERT INTO pending_pair VALUES ('paired'); END;
    CREATE TEMP TRIGGER pair_second AFTER UPDATE OF payload_json ON journal_items WHEN NEW.session_id='other'
      BEGIN INSERT INTO published_pair VALUES ('paired'); END`)
  const result = await commitCommands(
    [target, other].map((target) => command([message('last')], target)),
    200
  )
  expect(result.outcomes.map((outcome) => outcome.committed)).toEqual([true, true])
  expect(db.isTransaction).toBe(false)
  expect(db.prepare('SELECT id FROM published_pair').get()).toEqual({ id: 'paired' })
  expect(result.outcomes).toMatchObject([
    {
      committed: true,
      value: {
        cursor: { epoch: 'epoch', sequence: 12 },
        publication: { items: [{ body: { blocks: [{ type: 'text', text: 'last' }] } }] }
      }
    },
    {
      committed: true,
      value: {
        cursor: { epoch: 'epoch', sequence: 2 },
        publication: { items: [{ body: { blocks: [{ type: 'text', text: 'last' }] } }] }
      }
    }
  ])
})

it('accepts an optimistic echo once, preserving its local body and moved placement', async () => {
  const { db, commit, commitCommands, item, seedSend, seedItem } = fixture()
  seedSend()
  db.exec(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
      attempt_index,current,item_id,ordinal,submitted_at,accepted_sequence,fingerprint,
      dispatch_state,candidate,payload_json,admitted_personal)
    SELECT session_id,epoch,message_id,0,0,0,item_id,0,0,NULL,fingerprint,'unknown',0,payload_json,0
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
    body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } },
    holdReason: null,
    returnedReason: 'refused',
    returnedRejection: null,
    consumedAs: 'command',
    queuedAt: null
  }
  db.prepare(
    `INSERT INTO journal_queue_cards(session_id,epoch,message_id,revision,state,position,command_turn_item_id,payload_json)
      VALUES('chat','epoch','card',1,'returned',1,'orca:reported-command',?)`
  ).run(JSON.stringify(card))
  const input = message('original', 'unused', 'item')
  input.identity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }
  input.body.role = 'user'
  const answer = await commit(input)
  expect(answer.outcomes[0]).toMatchObject({
    committed: true,
    value: {
      inputChanged: true,
      publication: {
        acceptedInputs: { latestAcceptedTurnSequence: 1, latestPersonAcceptedSequence: 1 },
        cards: [],
        receipts: [
          { clientMessageId: 'send', acceptedAt: 100, cursor: { epoch: 'epoch', sequence: 11 } }
        ]
      }
    }
  })
  expect(db.prepare("SELECT state FROM journal_queue_cards WHERE message_id='card'").get()).toEqual(
    { state: 'returned' }
  )
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
  expect(item('orca:send')).toMatchObject({
    sequence: 7,
    observedAt: 70,
    body: { blocks: [{ type: 'text', text: 'original' }] }
  })
  input.body.blocks = [{ type: 'text', text: 'provider normalized' }]
  expect((await commit(input)).outcomes[0]).toMatchObject({
    committed: true,
    value: { publication: { receipts: [] } }
  })
  expect(item('orca:send')?.body).toEqual({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'original' }]
  })
  const reported = await commitCommands([
    {
      target,
      operation: {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'reported-command' },
        body: { kind: 'turn', turnId: 'command', state: 'completed' },
        options: { fence: 1, turnScope: { kind: 'thread' } }
      }
    }
  ])
  expect(reported.outcomes[0]).toMatchObject({
    committed: true,
    value: { publication: { cards: [{ messageId: 'card', state: 'withdrawn' }] } }
  })
})

it('refuses a snapshot after the saved turn ends and commits only a successful step prefix', async () => {
  const { db, batch, commit, item } = fixture()
  const turns = await batch.run(['running', 'completed'] as const, (state) =>
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'turn' },
        body: { kind: 'turn', turnId: 'turn', state, startedAt: 1 },
        options: { fence: 1, turnScope: { kind: 'thread' } }
      },
      30
    )
  )
  expect(turns.outcomes).toMatchObject([
    { committed: true, value: { items: [{ revision: 1, body: { state: 'running' } }] } },
    { committed: true, value: { items: [{ revision: 2, body: { state: 'completed' } }] } }
  ])
  expect(item('orca:turn')).toMatchObject({ sequence: 11, revision: 2, observedAt: 30 })
  const late = message('late')
  late.options.turnScope = { kind: 'turn', turnItemId: 'orca:turn' }
  expect((await commit(late)).outcomes[0]).toMatchObject({
    committed: true,
    value: {
      cursor: { epoch: 'epoch', sequence: 12 },
      publication: { items: [] },
      value: { outcomes: [{ kind: 'dropped', reason: 'turn-settled' }] }
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
      cursor: { epoch: 'epoch', sequence: 13 },
      publication: { items: [{ itemId: 'orca:prefix' }] },
      value: { failure: { message: 'refused' } }
    }
  })
  expect(item('orca:refused')).toBeUndefined()
  expect(item('orca:suffix')).toBeUndefined()
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

it('retains a stream placement while honoring a newer moved row and a settled turn', async () => {
  const { db, commit, item } = fixture()
  await commit({
    ...message('', 'turn', 'item'),
    body: { kind: 'message', role: 'assistant', blocks: [] }
  })
  const started = await commit(message('first'))
  const first = started.outcomes[0]
  if (!first?.committed) {
    throw new Error('stream start did not commit')
  }
  const second = { ...message('second'), kind: 'text-snapshot' as const }
  await commit(second)
  expect(item('orca:assistant')).toMatchObject({
    revision: 2,
    sequence: 12,
    observedAt: 100,
    body: { blocks: [{ type: 'text', text: 'second' }] }
  })
  const moved = {
    ...item('orca:assistant')!,
    revision: 3,
    sequence: 8,
    sequenceIndex: 2,
    observedAt: 50,
    turnScope: { kind: 'turn' as const, turnItemId: 'orca:turn' }
  }
  db.prepare(`UPDATE journal_items SET revision=3,sequence=8,sequence_index=2,payload_json=?,placement_json=?
    WHERE item_id='orca:assistant'`).run(JSON.stringify(moved), journalDomainItemPlacement(moved))
  await commit(second)
  expect(item('orca:assistant')).toMatchObject({
    revision: 4,
    sequence: 8,
    sequenceIndex: 2,
    observedAt: 50,
    turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
  })
  db.prepare(`UPDATE journal_items SET payload_json=? WHERE item_id='orca:turn'`).run(
    JSON.stringify({
      itemId: 'orca:turn',
      revision: 2,
      sequence: 11,
      observedAt: 100,
      body: { kind: 'turn', turnId: 'turn', state: 'completed' },
      turnScope: { kind: 'thread' }
    })
  )
  const late = await commit(second)
  expect(late.outcomes[0]).toMatchObject({
    committed: true,
    value: {
      value: { outcomes: [{ kind: 'dropped', reason: 'turn-settled', turnItemId: 'orca:turn' }] }
    }
  })
  expect(item('orca:assistant')?.revision).toBe(4)
})

it('retains removed turn identity when its item is reinserted', () => {
  const { db, item } = fixture()
  db.prepare(`INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision)
    VALUES(?,?,?,9)`).run(target.sessionId, target.epoch, 'orca:turn')
  db.prepare(`INSERT INTO journal_removed_turns(session_id,epoch,turn_id)
    VALUES(?,?,?)`).run(target.sessionId, target.epoch, 'removed-turn')
  db.exec('BEGIN')
  applyJournalDomainItem(
    db,
    target,
    {
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: 'turn' },
      body: { kind: 'turn', turnId: 'removed-turn', state: 'completed' },
      options: { fence: 1, turnScope: { kind: 'thread' } }
    },
    100
  )
  db.exec('COMMIT')
  expect(item('orca:turn')).toMatchObject({ revision: 10 })
  expect(
    readJournalDomainItems(db, target, { kind: 'named-turn', turnId: 'removed-turn' })
  ).toEqual({
    kind: 'named-turn',
    turn: { scope: { kind: 'turn', turnItemId: 'orca:turn' }, removed: true }
  })
})
