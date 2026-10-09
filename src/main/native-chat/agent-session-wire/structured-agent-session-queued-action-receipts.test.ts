// Send now, Delete and Resume accept through their own command receipt, committed with the draft or
// row they change: no ledger policy decides them, a retry answers from that receipt, and an id
// another command already used is refused.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import { agentSessionMessagePayload } from '../../../shared/structured-agent-session-send-mutation'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const
const OLD = NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 60_000
const FUTURE = NOW + 6 * 60_000

let rig: QueuedMessageTestRig
let serial = 0

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function opId(at = NOW): string {
  serial += 1
  return `${at}-${serial.toString(16).padStart(32, 'e')}`
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

function receipt(id: string) {
  return rig.store.readCommandReceipt(CALLER_SCOPE, id)
}

function ledgerRow(id: string) {
  return rig.store.listOperationRows().find((row) => row.operationId === id)
}

function failReceiptWrites(): () => void {
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(`CREATE TRIGGER fail_queued_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
  return () => db.exec('DROP TRIGGER fail_queued_receipt')
}

function writeUnreadableReceipt(id: string, method: string): void {
  openTestJournalHostDatabase(rig.root)
    .db.prepare(
      `INSERT INTO agent_session_command_receipts (operation_id, session_id, caller_key, method,
        fingerprint, status, result_json, rejection_json, accepted_at)
       VALUES (?, ?, ?, ?, 'x', 'accepted', '{', NULL, 0)`
    )
    .run(id, SESSION, CALLER.callerKey, method)
}

/** What a rewind does to the conversation: a new epoch rebuilt with none of the old rows. */
async function rewindConversation(): Promise<void> {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected an open conversation')
  }
  await journal.replaceEpochItems(
    'handle_forked',
    rig.store.getRecord(SESSION)!.lease.runtimeFence,
    []
  )
}

/** A stop that leaves a waiting card paused, which only a Resume lifts. */
async function pausedQueue(): Promise<void> {
  await rig.workingSend()
  await queuedDraft('held by stop')
  await rig.stop()
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
}

const UNKNOWN = { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
const CONFLICT = {
  ok: false,
  refusal: { code: 'agent_session_operation_conflict', details: { reason: 'operationIdReused' } }
}

describe('Send now', () => {
  it.each([
    ['older than a day', OLD],
    ['six minutes ahead', FUTURE]
  ])('accepts an id %s and hands the card off once', async (_case, at) => {
    await rig.workingSend()
    const draftId = await queuedDraft('send me now')
    const id = opId(at)
    expect(await rig.sendNow(draftId, id)).toMatchObject({
      ok: true,
      replayed: false,
      value: { clientMessageId: id, submission: { queuedMessageId: draftId } }
    })
    expect(receipt(id)).toMatchObject({
      verdict: 'readable',
      receipt: { method: 'agentSession.queuedMessageSend', result: { kind: 'journal-row' } }
    })
    expect(ledgerRow(id)?.outcome).toMatchObject({ status: 'succeeded' })
  })

  it('answers the same id twice, in turn or at once, from one hand-off', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('send me once')
    const id = opId()
    const [first, second] = await Promise.all([rig.sendNow(draftId, id), rig.sendNow(draftId, id)])
    const third = await rig.sendNow(draftId, id)
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({ ok: true, replayed: true, value: { clientMessageId: id } })
    expect(third).toMatchObject({ ok: true, replayed: true, value: { clientMessageId: id } })
    const handoffs = (await rig.host.journalSnapshot(SESSION)).submissions.filter(
      (entry) => entry.queuedMessageId === draftId
    )
    expect(handoffs).toHaveLength(1)
  })

  it('points another id at the hand-off that already took the card', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('already sent')
    const first = opId()
    await rig.sendNow(draftId, first)
    const alias = opId()
    expect(await rig.sendNow(draftId, alias)).toMatchObject({
      ok: true,
      replayed: false,
      value: { clientMessageId: first }
    })
    expect(receipt(alias)).toMatchObject({
      receipt: { result: { kind: 'queued-draft', messageId: draftId } }
    })
    expect(await rig.sendNow(draftId, alias)).toMatchObject({
      ok: true,
      replayed: true,
      value: { clientMessageId: first }
    })
  })

  it('refuses the same id naming another card', async () => {
    await rig.workingSend()
    const first = await queuedDraft('first card')
    const second = await queuedDraft('second card')
    const id = opId()
    await rig.sendNow(first, id)
    expect(await rig.sendNow(second, id)).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_conflict',
        details: { reason: 'operationIdReused' }
      }
    })
    expect(await rig.drafts()).toContainEqual(expect.objectContaining({ messageId: second }))
  })

  it('rolls the hand-off back when its receipt cannot be saved, then sends on a retry', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('roll me back')
    const id = opId()
    const restore = failReceiptWrites()
    await expect(rig.sendNow(draftId, id)).rejects.toThrow('receipt unavailable')
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.drafts()).toContainEqual(expect.objectContaining({ messageId: draftId }))
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(ledgerRow(id)).toBeUndefined()
    restore()
    expect(await rig.sendNow(draftId, id)).toMatchObject({ ok: true, replayed: false })
  })

  it('records nothing for a refusal before acceptance', async () => {
    const id = opId()
    expect(await rig.sendNow('no-such-card', id)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(ledgerRow(id)).toBeUndefined()
  })

  it('answers unknown, never success, when the hand-off it points at cannot be recorded', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('sent by another')
    const first = opId()
    await rig.sendNow(draftId, first)
    const alias = opId()
    const restore = failReceiptWrites()
    expect(await rig.sendNow(draftId, alias)).toMatchObject(UNKNOWN)
    expect(await rig.sendNow(draftId, alias)).toMatchObject(UNKNOWN)
    restore()
    expect(await rig.sendNow(draftId, alias)).toMatchObject({
      ok: true,
      replayed: true,
      value: { clientMessageId: first }
    })
    expect(receipt(alias)).toMatchObject({
      receipt: { result: { kind: 'queued-draft', messageId: draftId } }
    })
  })

  it('answers an unreadable receipt as unknown and hands nothing off', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('unknown send')
    const id = opId()
    writeUnreadableReceipt(id, 'agentSession.queuedMessageSend')
    expect(await rig.sendNow(draftId, id)).toMatchObject(UNKNOWN)
    expect(await rig.handoff(draftId)).toBeUndefined()
  })

  it('answers a retry after a rewind dropped its hand-off as spent, and sends nothing again', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('rewound away')
    const id = opId()
    expect(await rig.sendNow(draftId, id)).toMatchObject({ ok: true, replayed: false })
    await rewindConversation()
    expect(await rig.sendNow(draftId, id)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', details: { reason: 'resultLost' } }
    })
    expect(await rig.handoff(draftId)).toBeUndefined()
  })
})

describe('Delete', () => {
  it('withdraws once under an old or future id and replays the withdrawal', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('delete me')
    const id = opId(OLD)
    expect(await rig.deleteQueued(draftId, id)).toMatchObject({
      ok: true,
      replayed: false,
      value: { deleted: true, messageId: draftId }
    })
    expect(receipt(id)).toMatchObject({
      receipt: { result: { kind: 'queued-draft', messageId: draftId } }
    })
    expect(await rig.deleteQueued(draftId, id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { deleted: true, messageId: draftId }
    })
    const future = opId(FUTURE)
    expect(await rig.deleteQueued(draftId, future)).toMatchObject({
      ok: true,
      replayed: false,
      value: { deleted: false, disposition: 'withdrawn' }
    })
  })

  it.each(['missing', 'withdrawn'] as const)(
    "replays a no-op's first answer when the card was %s",
    async (disposition) => {
      await rig.workingSend()
      const draftId = disposition === 'missing' ? 'no-such-card' : await queuedDraft('gone')
      if (disposition === 'withdrawn') {
        await rig.deleteQueued(draftId)
      }
      const id = opId()
      const answer = { deleted: false, messageId: draftId, disposition }
      expect(await rig.deleteQueued(draftId, id)).toMatchObject({
        ok: true,
        replayed: false,
        value: answer
      })
      expect(receipt(id)).toMatchObject({
        receipt: {
          result: {
            kind: 'no-op',
            outcome: { kind: 'queue-delete', messageId: draftId, disposition }
          }
        }
      })
      expect(await rig.deleteQueued(draftId, id)).toEqual(
        expect.objectContaining({ ok: true, replayed: true, value: answer })
      )
    }
  )

  it('answers concurrent copies of one id with one withdrawal', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('delete once')
    const id = opId()
    const [first, second] = await Promise.all([
      rig.deleteQueued(draftId, id),
      rig.deleteQueued(draftId, id)
    ])
    expect(first).toMatchObject({ ok: true, replayed: false, value: { deleted: true } })
    expect(second).toMatchObject({ ok: true, replayed: true, value: { deleted: true } })
  })

  it('keeps the card when its receipt cannot be saved', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('keep me')
    const id = opId()
    const restore = failReceiptWrites()
    await expect(rig.deleteQueued(draftId, id)).rejects.toThrow('receipt unavailable')
    restore()
    expect(await rig.drafts()).toContainEqual(
      expect.objectContaining({ messageId: draftId, state: 'waiting' })
    )
    expect(ledgerRow(id)).toBeUndefined()
  })

  it('answers an unreadable receipt as unknown and withdraws nothing', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('unknown delete')
    const id = opId()
    writeUnreadableReceipt(id, 'agentSession.queuedMessageDelete')
    expect(await rig.deleteQueued(draftId, id)).toMatchObject(UNKNOWN)
    expect(await rig.drafts()).toContainEqual(
      expect.objectContaining({ messageId: draftId, state: 'waiting' })
    )
  })

  it('refuses the same id naming another card and keeps that card', async () => {
    await rig.workingSend()
    const first = await queuedDraft('first card')
    const second = await queuedDraft('second card')
    const id = opId()
    await rig.deleteQueued(first, id)
    expect(await rig.deleteQueued(second, id)).toMatchObject(CONFLICT)
    expect(await rig.drafts()).toContainEqual(
      expect.objectContaining({ messageId: second, state: 'waiting' })
    )
  })

  it('answers unknown when a no-op cannot be recorded, and its retry never withdraws a card that arrived since', async () => {
    await rig.workingSend()
    const lateCard = opId()
    const id = opId()
    const restore = failReceiptWrites()
    expect(await rig.deleteQueued(lateCard, id)).toMatchObject(UNKNOWN)
    restore()
    // The card the Delete named lands after it: a send whose id is that card's.
    const body = hostTestMessage('arrives late')
    const fields = { body: agentSessionMessagePayload(body), delivery: 'queue-if-active' as const }
    expect(
      await rig.host.send(CALLER, {
        envelope: rig.envelope(fields, 'agentSession.send', lateCard),
        ...fields,
        body,
        userSend: true
      })
    ).toMatchObject({ ok: true, value: { queued: { messageId: lateCard } } })
    expect(await rig.deleteQueued(lateCard, id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { deleted: false, messageId: lateCard, disposition: 'missing' }
    })
    expect(await rig.drafts()).toContainEqual(
      expect.objectContaining({ messageId: lateCard, state: 'waiting' })
    )
  })

  it('answers a retry after a rewind from its receipt, withdrawing nothing again', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('deleted then rewound')
    const id = opId()
    await rig.deleteQueued(draftId, id)
    await rewindConversation()
    expect(await rig.deleteQueued(draftId, id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { deleted: true, messageId: draftId }
    })
  })
})

describe('Resume', () => {
  it('lifts the pause once under an old id and never lifts a later pause under it', async () => {
    await rig.workingSend()
    await queuedDraft('held by stop')
    await queuedDraft('held by the second stop')
    await rig.stop()
    const id = opId(OLD)
    expect(await rig.resume(id)).toMatchObject({
      ok: true,
      replayed: false,
      value: { resumed: true }
    })
    expect(receipt(id)).toMatchObject({ receipt: { result: { kind: 'journal-row' } } })
    await rig.stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.resume(id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { resumed: false }
    })
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('records a no-op Resume and replays it', async () => {
    const id = opId(FUTURE)
    expect(await rig.resume(id)).toMatchObject({
      ok: true,
      replayed: false,
      value: { resumed: false }
    })
    expect(receipt(id)).toMatchObject({
      receipt: { result: { kind: 'no-op', outcome: { kind: 'queue-resume', resumed: false } } }
    })
    expect(await rig.resume(id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { resumed: false }
    })
  })

  it('keeps the pause when its receipt cannot be saved', async () => {
    await rig.workingSend()
    await queuedDraft('still held')
    await rig.stop()
    const restore = failReceiptWrites()
    await expect(rig.resume(opId())).rejects.toThrow('receipt unavailable')
    restore()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('answers concurrent copies of one id with one Resume', async () => {
    await pausedQueue()
    const id = opId()
    const [first, second] = await Promise.all([rig.resume(id), rig.resume(id)])
    expect(first).toMatchObject({ ok: true, replayed: false, value: { resumed: true } })
    expect(second).toMatchObject({ ok: true, replayed: true, value: { resumed: false } })
    expect(await rig.queuePause()).toBeNull()
  })

  it('answers unknown when a no-op cannot be recorded, and its retry never lifts a later pause', async () => {
    const id = opId()
    let restore = failReceiptWrites()
    expect(await rig.resume(id)).toMatchObject(UNKNOWN)
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    restore()
    await pausedQueue()
    // Still unrecordable: still unknown, and the Stop's pause stands.
    restore = failReceiptWrites()
    expect(await rig.resume(id)).toMatchObject(UNKNOWN)
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    restore()
    expect(await rig.resume(id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { resumed: false }
    })
    expect(receipt(id)).toMatchObject({
      receipt: { result: { kind: 'no-op', outcome: { kind: 'queue-resume', resumed: false } } }
    })
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('answers an unreadable receipt as unknown and lifts nothing', async () => {
    await pausedQueue()
    const id = opId()
    writeUnreadableReceipt(id, 'agentSession.queuedMessagesResume')
    expect(await rig.resume(id)).toMatchObject(UNKNOWN)
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('answers a retry after a rewind from its receipt and never lifts the pause a later Stop set', async () => {
    await pausedQueue()
    const id = opId()
    expect(await rig.resume(id)).toMatchObject({ ok: true, value: { resumed: true } })
    await rewindConversation()
    await rig.stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.resume(id)).toMatchObject({
      ok: true,
      replayed: true,
      value: { resumed: false }
    })
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })
})

describe.each([
  ['Delete', (id: string) => rig.deleteQueued('some-card', id)],
  ['Resume', (id: string) => rig.resume(id)]
])('%s refused before acceptance', (_action, act) => {
  it('records nothing', async () => {
    const id = 'not-an-operation-id'
    expect(await act(id)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(ledgerRow(id)).toBeUndefined()
  })
})

describe('an id reused across commands', () => {
  const conflict = CONFLICT

  it('refuses a Stop reusing a Delete id, through the compatibility ledger row', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('delete then stop')
    const id = opId()
    await rig.deleteQueued(draftId, id)
    expect(await rig.stop(id)).toMatchObject(conflict)
  })

  it('refuses a Delete or Resume reusing a Stop id, committing nothing', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('stop then delete')
    const id = opId()
    await rig.stop(id)
    expect(await rig.deleteQueued(draftId, id)).toMatchObject(conflict)
    expect(await rig.resume(id)).toMatchObject(conflict)
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
  })

  it('refuses a Send now reusing a Delete id, and the reverse', async () => {
    await rig.workingSend()
    const first = await queuedDraft('first')
    const second = await queuedDraft('second')
    const deleteId = opId()
    await rig.deleteQueued(first, deleteId)
    expect(await rig.sendNow(second, deleteId)).toMatchObject(conflict)
    const sendId = opId()
    await rig.sendNow(second, sendId)
    expect(await rig.deleteQueued(second, sendId)).toMatchObject(conflict)
  })
})
