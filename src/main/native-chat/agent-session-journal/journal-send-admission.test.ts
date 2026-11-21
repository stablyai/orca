import { afterEach, expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import {
  automaticSubmissionFixture,
  automaticBody,
  automaticMail
} from './journal-automatic-submission.test-fixture'
import { lifecycleFacts } from './journal-domain-lifecycle.test-fixture'
import type { JournalSendAdmission } from './journal-send-admission'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'
import { commandReceiptFixture } from './writing/command-receipt-test-support'
import { readCommandReceipt } from './writing/command-receipt-table'
import { selectJournalEligibleQueueCard } from './journal-domain-input-eligibility'
import { JournalSqlScope } from './journal-sql-scope'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function fixture() {
  const f = automaticSubmissionFixture(cleanups)
  const send = (
    id: string,
    extra: Partial<JournalSendAdmission> = {},
    effects?: JournalWriterCommand['effects'],
    mail?: JournalWriterHostFacts['mail']
  ) =>
    f.run(
      {
        kind: 'send-admission',
        input: {
          clientMessageId: id,
          body: automaticBody(id),
          payloadFingerprint: id,
          fence: 1,
          handoverRecorded: true,
          origin: 'host',
          source: { kind: 'user' }
        },
        fromPerson: true,
        fromAgent: false,
        deliveryMode: 'steer',
        ...extra
      },
      {
        ...lifecycleFacts,
        identity: { ...lifecycleFacts.identity, sessionId: 'chat-test' },
        send: f.selection.authority,
        mail
      },
      effects
    )
  const receipt = (id: string): JournalWriterCommand['effects'] => [
    {
      kind: 'receipt',
      scope: { kind: 'global' },
      receipt: commandReceiptFixture({ operationId: id, sessionId: 'chat-test' }),
      row: {
        at: 'last',
        kinds: ['submission'],
        answer: 'journal-row',
        absent: { kind: 'queued-draft', messageId: id }
      }
    }
  ]
  return { ...f, send, receipt }
}

it('accepts the idle send and its receipt together, then queues and replays a following send', async () => {
  const f = fixture()
  expect((await f.send('first', {}, f.receipt('first'))).value).toMatchObject({
    kind: 'admitted',
    value: { clientMessageId: 'first', submission: { dispatchState: 'pending' } }
  })
  expect(readCommandReceipt(f.db, { kind: 'global' }, 'first')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', epoch: 'epoch', sequence: 1 } }
  })
  const queued = await f.send('second', {}, f.receipt('second'))
  expect(queued.value).toEqual({
    kind: 'admitted',
    value: {
      clientMessageId: 'second',
      queued: { messageId: 'second', position: 1, state: 'waiting' }
    }
  })
  expect(f.attempt('second')).toBeNull()
  expect((await f.send('second')).value).toEqual(queued.value)
  expect(readCommandReceipt(f.db, { kind: 'global' }, 'second')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'queued-draft', messageId: 'second' } }
  })
  expect(
    (
      await f.send('first', {
        input: {
          clientMessageId: 'first',
          body: automaticBody('changed'),
          payloadFingerprint: 'changed',
          fence: 1
        }
      })
    ).value
  ).toMatchObject({ kind: 'refused', refusal: { details: { reason: 'messageIdReused' } } })
})

it('rolls back either acceptance when saving its receipt fails', async () => {
  const f = fixture()
  f.db.exec(`CREATE TRIGGER refuse_send_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
  await expect(f.send('immediate', {}, f.receipt('immediate'))).rejects.toThrow(
    'receipt unavailable'
  )
  expect(f.attempt('immediate')).toBeNull()
  await f.turn()
  await expect(f.send('queued', {}, f.receipt('queued'))).rejects.toThrow('receipt unavailable')
  expect(f.card('queued')).toBeUndefined()
})

it('leaves admission unanswered until backlog custody is known, and enforces the same pending barrier for publication and drain', async () => {
  const f = fixture()
  await f.enqueue('mail', { body: { ...automaticBody('notice'), from: automaticMail } })
  expect((await f.send('person')).value).toEqual({ kind: 'needs-custody', source: automaticMail })
  expect(f.card('person')).toBeUndefined()
  expect(f.attempt('person')).toBeNull()
  expect(
    (await f.send('person', {}, undefined, [[JSON.stringify(automaticMail), 'unavailable']])).value
  ).toMatchObject({
    kind: 'admitted',
    value: { submission: { clientMessageId: 'person' } }
  })
  expect(
    selectJournalEligibleQueueCard(
      new JournalSqlScope(f.db, 'chat-test', 'epoch'),
      f.selection.authority,
      100,
      { reopenFloor: null, mail: [[JSON.stringify(automaticMail), 'owed']] },
      true
    )
  ).toMatchObject({ kind: 'selected', card: null })
  expect((await f.claim('automatic', f.prepare(100, 'owed'))).value).toEqual({ kind: 'waiting' })
  expect((await f.send('later')).value).toMatchObject({
    kind: 'admitted',
    value: { queued: { state: 'waiting' } }
  })
})

it('refuses a superseded continuation before it can queue or accept', async () => {
  const f = fixture()
  await f.turn()
  expect((await f.send('continue', { continuationOfTurnItemId: 'orca:old' })).value).toMatchObject({
    kind: 'refused',
    refusal: { details: { reason: 'continuationSuperseded' } }
  })
  expect(f.card('continue')).toBeUndefined()
  expect(f.attempt('continue')).toBeNull()
})

it('queues agent-origin failure recovery while allowing a person to resume the chat', async () => {
  const f = fixture()
  await f.run({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'failure' },
    body: { kind: 'turn', turnId: 'failed', state: 'completed', outcome: 'failure' },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  })
  expect((await f.send('agent', { fromPerson: false, fromAgent: true })).value).toMatchObject({
    kind: 'admitted',
    value: { queued: { state: 'waiting' } }
  })
  expect((await f.send('person')).value).toMatchObject({
    kind: 'admitted',
    value: { submission: { clientMessageId: 'person' } }
  })
})

it('keeps actionable approvals in front of sends, but lets a person recover an unanswerable approval', async () => {
  const f = fixture()
  const prompt = {
    kind: 'approval' as const,
    title: 'Run?',
    detail: null,
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: {
      state: 'pending' as const,
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
  }
  const write = (subject?: { kind: string }) => {
    const body = { ...prompt, ...(subject ? { subject } : {}) }
    if (!isAdmissibleAgentJournalItemBody(body)) {
      throw new Error('invalid approval fixture')
    }
    return f.run({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: 'approval' },
      body,
      options: { fence: 1, turnScope: { kind: 'thread' } }
    })
  }
  await write()
  expect((await f.send('waiting')).value).toMatchObject({
    kind: 'admitted',
    value: { queued: { state: 'waiting' } }
  })
  await write({ kind: 'future-approval' })
  expect((await f.send('person')).value).toMatchObject({
    kind: 'admitted',
    value: { submission: { clientMessageId: 'person' } }
  })
})
