import { afterEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { automaticSubmissionFixture } from '../journal-automatic-submission.test-fixture'
import { lifecycleFacts } from '../journal-domain-lifecycle.test-fixture'
import { commandReceiptFixture } from '../writing/command-receipt-test-support'
import type { JournalWriterCommand } from '../journal-writer-command'
import {
  clearRewoundJournalConnectorReplies,
  forgetJournalConnectorReplies,
  fillJournalConnectorReplies,
  readJournalConnectorReplies,
  sentJournalConnectorReplies
} from './journal-connector-replies'

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
