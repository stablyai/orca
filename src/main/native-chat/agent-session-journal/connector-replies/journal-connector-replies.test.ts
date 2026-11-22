import { afterEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { JOURNAL_CONNECTOR_REPLY_PROSE_BYTES } from '../../../../shared/agent-session/journal/journal-connector-reply'
import { automaticSubmissionFixture } from '../journal-automatic-submission.test-fixture'
import { lifecycleFacts } from '../journal-domain-lifecycle.test-fixture'
import { commandReceiptFixture } from '../writing/command-receipt-test-support'
import type { JournalWriterCommand } from '../journal-writer-command'
import {
  claimJournalConnectorReplies,
  clearRewoundJournalConnectorReplies,
  cutJournalConnectorReplies,
  forgetJournalConnectorReplies,
  fillJournalConnectorReplies,
  recutJournalConnectorReplies,
  releaseJournalConnectorClaim,
  repointJournalConnectorClaim,
  sentJournalConnectorReplies,
  withdrawJournalConnectorReplies
} from './journal-connector-replies'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from './journal-connector-replies-read'
import { ensureJournalConnectorRepliesSchema } from './journal-connector-replies-schema'

// Design item 125 §8, journal layer: the outbox row commits with its admission, its first fill
// wins, and a rewind, a chat delete and the cloud's acceptance settle it.

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }

const stamped = (
  text: string,
  delivery: { deliveryId: string; carried?: string[]; source?: string }
): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  origin: 'connector',
  connectorDelivery: {
    account: 'account-a',
    conversation: { ...SLACK, ...(delivery.source ? { source: delivery.source } : {}) },
    deliveryId: delivery.deliveryId,
    ...(delivery.carried ? { carried: delivery.carried } : {})
  }
})

function fixture() {
  const f = automaticSubmissionFixture(cleanups)
  const send = (
    id: string,
    body: AgentJournalMessageItem,
    effects?: JournalWriterCommand['effects']
  ) =>
    f.run(
      {
        kind: 'send-admission',
        input: {
          clientMessageId: id,
          body,
          payloadFingerprint: id,
          fence: 1,
          handoverRecorded: true,
          origin: 'host',
          source: { kind: 'user' }
        },
        fromPerson: true,
        fromAgent: false,
        deliveryMode: 'queue'
      },
      {
        ...lifecycleFacts,
        identity: { ...lifecycleFacts.identity, sessionId: 'chat-test' },
        send: f.selection.authority
      },
      effects
    )
  const rows = () =>
    readJournalConnectorReplies(f.db).map((row) => ({
      deliveryId: row.deliveryId,
      messageId: row.messageId,
      queued: row.queued,
      outcome: row.fill?.outcome ?? null
    }))
  return { ...f, send, rows }
}

it('writes one row per delivery with the admission that takes it, immediate or queued', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1' }))
  await f.turn()
  await f.send('second', stamped('and tests', { deliveryId: 'd2', carried: ['d3', 'd4'] }))
  // A repeated admission writes nothing more; another source isn't answered through the outbox.
  await f.send('second', stamped('and tests', { deliveryId: 'd2', carried: ['d3', 'd4'] }))
  await f.send('linear', stamped('elsewhere', { deliveryId: 'l1', source: 'linear' }))
  expect(f.rows()).toEqual([
    { deliveryId: 'd1', messageId: 'first', queued: false, outcome: null },
    { deliveryId: 'd2', messageId: 'second', queued: true, outcome: null },
    { deliveryId: 'd3', messageId: 'second', queued: true, outcome: null },
    { deliveryId: 'd4', messageId: 'second', queued: true, outcome: null }
  ])
})

it('writes no row for an admission that never committed', async () => {
  const f = fixture()
  f.db.exec(`CREATE TRIGGER refuse_send_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
  const receipt: JournalWriterCommand['effects'] = [
    {
      kind: 'receipt',
      scope: { kind: 'global' },
      receipt: commandReceiptFixture({ operationId: 'first', sessionId: 'chat-test' }),
      row: {
        at: 'last',
        kinds: ['submission'],
        answer: 'journal-row',
        absent: { kind: 'queued-draft', messageId: 'first' }
      }
    }
  ]
  await expect(f.send('first', stamped('review', { deliveryId: 'd1' }), receipt)).rejects.toThrow(
    'receipt unavailable'
  )
  expect(f.rows()).toEqual([])
})

it('keeps the first fill, clears what a rewind removed, and forgets a deleted chat’s requests', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1' }))
  await f.turn()
  await f.send('second', stamped('and tests', { deliveryId: 'd2' }))
  await f.send('third', stamped('and docs', { deliveryId: 'd3' }))
  const fill = (outcome: 'answered' | 'failed', prose?: string) =>
    fillJournalConnectorReplies(
      f.db,
      [
        {
          account: 'account-a',
          deliveryId: 'd1',
          outcome,
          answerDeliveryId: 'd1',
          ...(prose ? { prose } : {})
        }
      ],
      10
    )
  expect(fill('answered', 'Done.')).toBe(1)
  expect(fill('failed')).toBe(0)
  expect(readJournalConnectorReplies(f.db)[0]?.fill).toMatchObject({
    outcome: 'answered',
    prose: 'Done.'
  })
  // A rewind removed the second card's message: it was cleared before its answer.
  f.db.exec(`CREATE TEMP TABLE IF NOT EXISTS journal_rewind_removals(item_id TEXT PRIMARY KEY)`)
  f.db.exec(`INSERT INTO journal_rewind_removals VALUES ('orca:second')`)
  clearRewoundJournalConnectorReplies(f.db, { sessionId: 'chat-test', epoch: 'epoch' }, 20)
  expect(f.rows().map((row) => [row.deliveryId, row.outcome])).toEqual([
    ['d1', 'answered'],
    ['d2', 'cleared'],
    ['d3', null]
  ])
  // The cloud took d1: it is gone. Then the chat is deleted: d3 is no longer there.
  sentJournalConnectorReplies(f.db, [{ account: 'account-a', deliveryId: 'd1' }], 30)
  forgetJournalConnectorReplies(f.db, 'chat-test', 40)
  expect(f.rows().map((row) => [row.deliveryId, row.outcome])).toEqual([
    ['d2', 'cleared'],
    ['d3', 'not_found']
  ])
})

it('keeps how long the answered turn ran, in a table an earlier build made too', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1' }))
  await f.send('second', stamped('and tests', { deliveryId: 'd2' }))
  // As an earlier build left it: no took_ms. Opening the journal again adds it, once.
  f.db.exec('ALTER TABLE journal_connector_replies DROP COLUMN took_ms')
  ensureJournalConnectorRepliesSchema(f.db)
  ensureJournalConnectorRepliesSchema(f.db)
  const fill = { account: 'account-a', outcome: 'answered' as const, prose: 'Done.' }
  fillJournalConnectorReplies(
    f.db,
    [
      { ...fill, deliveryId: 'd1', answerDeliveryId: 'd1', tookMs: 98_000 },
      { ...fill, deliveryId: 'd2', answerDeliveryId: 'd2' }
    ],
    10
  )
  const [first, second] = readJournalConnectorReplies(f.db)
  expect(first?.fill?.tookMs).toBe(98_000)
  expect(second?.fill).not.toHaveProperty('tookMs')
})

// Phase 1: a cut owes its rows to a continuation, the continuation's admission claims them, and
// every write states the state it expects, so a stale writer changes nothing.
it('lets only the continuation that claimed a cut’s rows fill them', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1', carried: ['d2'] }))
  const keys = [
    { account: 'account-a', deliveryId: 'd1' },
    { account: 'account-a', deliveryId: 'd2' }
  ]
  const cut = { turnId: 'turn-1', kind: 'restart' as const }
  expect(cutJournalConnectorReplies(f.db, { keys, cut })).toBe(2)
  // A cut row is not open: the cut turn's own late fill changes nothing.
  const answer = (
    deliveryId: string,
    expect?: { claimMessageId: string } | { cutTurnId: string }
  ) =>
    fillJournalConnectorReplies(
      f.db,
      [
        {
          account: 'account-a',
          deliveryId,
          outcome: 'answered',
          answerDeliveryId: 'd1',
          prose: 'Done.',
          ...(expect ? { expect } : {})
        }
      ],
      10
    )
  expect(answer('d1')).toBe(0)
  await f.turn()
  const claim: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: { cutTurnId: 'turn-1', cutKind: 'restart', origin: [] }
  }
  await f.send('continue-1', claim)
  // A second continuation of the same cut claims nothing: the first holds the rows.
  await f.send('continue-2', claim)
  expect(readJournalConnectorReplies(f.db).map((row) => row.claimMessageId)).toEqual([
    'continue-1',
    'continue-1'
  ])
  expect(answer('d1', { claimMessageId: 'continue-2' })).toBe(0)
  expect(answer('d1', { cutTurnId: 'turn-1' })).toBe(0)
  expect(answer('d1', { claimMessageId: 'continue-1' })).toBe(1)
  // The continuation's own turn was cut: its unfilled row is that cut's now, and a release of a
  // claim that no longer holds it changes nothing.
  const recut = { turnId: 'turn-2', kind: 'usage_limit' as const }
  expect(recutJournalConnectorReplies(f.db, 'continue-1', recut)).toBe(1)
  expect(releaseJournalConnectorClaim(f.db, 'continue-1')).toBe(0)
  expect(
    readJournalConnectorReplies(f.db).map((row) => [row.deliveryId, row.cut, row.fill?.outcome])
  ).toEqual([
    ['d1', cut, 'answered'],
    ['d2', recut, undefined]
  ])
  // Closing another cut leaves it; closing its own settles it once.
  expect(answer('d2', { cutTurnId: 'turn-1' })).toBe(0)
  expect(answer('d2', { cutTurnId: 'turn-2' })).toBe(1)
  expect(answer('d2', { cutTurnId: 'turn-2' })).toBe(0)
})

it('gives a removed continuation’s rows back to their cut, and drops a cut’s failure on any other end', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1' }))
  await f.send('second', stamped('and tests', { deliveryId: 'd2' }))
  const failure = { category: 'usage_limit' as const, usageLimit: { resetsAt: 5_000 } }
  cutJournalConnectorReplies(f.db, {
    keys: [
      { account: 'account-a', deliveryId: 'd1' },
      { account: 'account-a', deliveryId: 'd2' }
    ],
    cut: { turnId: 'turn-1', kind: 'usage_limit' },
    failure
  })
  expect(readJournalConnectorReplies(f.db).map((row) => row.cutFailure)).toEqual([failure, failure])
  await f.turn()
  await f.send('continue-1', {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: { cutTurnId: 'turn-1', cutKind: 'restart', origin: [] }
  })
  f.db.exec(`CREATE TEMP TABLE IF NOT EXISTS journal_rewind_removals(item_id TEXT PRIMARY KEY)`)
  f.db.exec(`INSERT INTO journal_rewind_removals VALUES ('orca:continue-1'), ('orca:second')`)
  clearRewoundJournalConnectorReplies(f.db, { sessionId: 'chat-test', epoch: 'epoch' }, 20)
  // The rewound card's row was cleared; the other is its cut's again, unclaimed.
  expect(
    readJournalConnectorReplies(f.db).map((row) => [row.deliveryId, row.claimMessageId])
  ).toEqual([
    ['d1', undefined],
    ['d2', 'continue-1']
  ])
  forgetJournalConnectorReplies(f.db, 'chat-test', 30)
  const rows = readJournalConnectorReplies(f.db)
  expect(rows.map((row) => [row.deliveryId, row.fill?.outcome])).toEqual([
    ['d1', 'not_found'],
    ['d2', 'cleared']
  ])
  expect(rows.map((row) => row.fill?.failure)).toEqual([undefined, undefined])
})

it('claims a cut’s still-open rows its claim names, and moves a queued claim to the send it became', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1', carried: ['d2'] }))
  await f.send('other', stamped('unrelated', { deliveryId: 'd3' }))
  // Admitted before any classification cut the rows: the claim takes the ones it names.
  const origin = [
    {
      account: 'account-a',
      conversation: SLACK,
      deliveryId: 'd1',
      carried: ['d2']
    }
  ]
  claimJournalConnectorReplies(f.db, { sessionId: 'chat-test', epoch: 'epoch' }, 'card-1', {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: { cutTurnId: 'turn-1', cutKind: 'restart', origin }
  })
  // Its card was handed over as a send of its own id.
  repointJournalConnectorClaim(f.db, { sessionId: 'chat-test', epoch: 'epoch' }, 'card-1', 'send-1')
  expect(
    readJournalConnectorReplies(f.db).map((row) => [
      row.deliveryId,
      row.cut?.turnId,
      row.claimMessageId
    ])
  ).toEqual([
    ['d1', 'turn-1', 'send-1'],
    ['d2', 'turn-1', 'send-1'],
    ['d3', undefined, undefined]
  ])
})

it('gives a withdrawn queued continuation’s rows back to their cut', async () => {
  const f = fixture()
  await f.send('first', stamped('review', { deliveryId: 'd1' }))
  claimJournalConnectorReplies(f.db, { sessionId: 'chat-test', epoch: 'epoch' }, 'card-1', {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: {
      cutTurnId: 'turn-1',
      cutKind: 'usage_limit',
      origin: [{ account: 'account-a', conversation: SLACK, deliveryId: 'd1' }]
    }
  })
  withdrawJournalConnectorReplies(f.db, { sessionId: 'chat-test', epoch: 'epoch' }, ['card-1'], 10)
  expect(
    readJournalConnectorReplies(f.db).map((row) => [
      row.deliveryId,
      row.cut?.turnId,
      row.claimMessageId,
      row.fill?.outcome
    ])
  ).toEqual([['d1', 'turn-1', undefined, undefined]])
})

it('pages one account’s filled, unsent rows in delivery id order after a cursor', () => {
  const f = fixture()
  const insert = (account: string, deliveryId: string, fields: { outcome?: string; sent?: true }) =>
    f.db
      .prepare(`INSERT INTO journal_connector_replies
        (account,delivery_id,source,external_id,session_id,epoch,message_id,queued,outcome,
         answer_delivery_id,prose,filled_at,sent_at)
        VALUES(?,?,'slack',?,'chat-test','epoch',?,0,?,?,?,?,?)`)
      .run(
        account,
        deliveryId,
        SLACK.externalId,
        `m-${deliveryId}`,
        fields.outcome ?? null,
        fields.outcome ? deliveryId : null,
        fields.outcome ? `answer ${deliveryId}` : null,
        fields.outcome ? 5 : null,
        fields.sent ? 6 : null
      )
  // Inserted out of order: the page's order is the key's, not the insert's.
  for (const id of ['d5', 'd2', 'd4', 'd1', 'd3']) {
    insert('account-a', id, { outcome: 'answered' })
  }
  insert('account-a', 'd0-open', {})
  insert('account-a', 'd2-sent', { outcome: 'answered', sent: true })
  insert('account-b', 'd0-other', { outcome: 'answered' })
  const page = (after: string | null) =>
    readOwedJournalConnectorReplies(f.db, 'account-a', after, 2).map((row) => row.deliveryId)
  expect(page(null)).toEqual(['d1', 'd2'])
  expect(page('d2')).toEqual(['d3', 'd4'])
  expect(page('d4')).toEqual(['d5'])
  expect(page('d5')).toEqual([])
  expect(readOwedJournalConnectorReplies(f.db, 'account-a', null, 1)[0]?.fill).toMatchObject({
    outcome: 'answered',
    answerDeliveryId: 'd1',
    prose: 'answer d1',
    filledAt: 5
  })
  expect(
    readOwedJournalConnectorReplies(f.db, 'account-b', null, 10).map((row) => row.deliveryId)
  ).toEqual(['d0-other'])
})

it('reads an oversize prose cut to just past the cap, and a capped one whole', () => {
  const f = fixture()
  const fill = (deliveryId: string, prose: string) => {
    f.db
      .prepare(`INSERT INTO journal_connector_replies
        (account,delivery_id,source,external_id,session_id,epoch,message_id,queued)
        VALUES('account-a',?,'slack',?,'chat-test','epoch',?,0)`)
      .run(deliveryId, SLACK.externalId, `m-${deliveryId}`)
    fillJournalConnectorReplies(
      f.db,
      [
        {
          account: 'account-a',
          deliveryId,
          outcome: 'answered',
          answerDeliveryId: deliveryId,
          prose
        }
      ],
      5
    )
  }
  const capped = 'é'.repeat(JOURNAL_CONNECTOR_REPLY_PROSE_BYTES / 2)
  fill('d1', 'x'.repeat(8 * 1024 * 1024))
  fill('d2', capped)
  const [huge, whole] = readOwedJournalConnectorReplies(f.db, 'account-a', null, 10)
  expect(huge?.fill?.prose).toHaveLength(JOURNAL_CONNECTOR_REPLY_PROSE_BYTES + 1)
  expect(whole?.fill?.prose).toBe(capped)
  // The whole-table read still keeps every prose as stored.
  expect(readJournalConnectorReplies(f.db)[0]?.fill?.prose).toHaveLength(8 * 1024 * 1024)
})
