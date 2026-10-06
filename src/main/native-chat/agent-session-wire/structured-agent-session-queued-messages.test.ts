// Mid-turn queueing against the real host, store and journal: a capable send
// while the session owes work becomes a draft, the drain converts exactly one
// draft when the work settles, Stop holds the queue (never withdrawing text)
// until a user send starts its turn and lifts the pause, /clear carries the
// cards to its replacement session, and a refused conversion comes back as a
// returned card while a withdrawn one waits again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { ConversationCommandParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import {
  rotateStructuredAgentSessionHostInstanceForTests,
  structuredQueuePauses
} from './structured-agent-session-queued-pause'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
let host: QueuedMessageTestRig['host']
let store: QueuedMessageTestRig['store']
let dispatch: QueuedMessageTestRig['dispatch']
let awaitStarted: QueuedMessageTestRig['awaitStarted']

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  ;({ host, store, dispatch, awaitStarted } = rig)
})

afterEach(() => rig.dispose())

const envelope: QueuedMessageTestRig['envelope'] = (...args) => rig.envelope(...args)
const send: QueuedMessageTestRig['send'] = (...args) => rig.send(...args)
const stop: QueuedMessageTestRig['stop'] = (...args) => rig.stop(...args)
const sendNow: QueuedMessageTestRig['sendNow'] = (...args) => rig.sendNow(...args)
const deleteQueued: QueuedMessageTestRig['deleteQueued'] = (...args) => rig.deleteQueued(...args)
const drafts: QueuedMessageTestRig['drafts'] = (...args) => rig.drafts(...args)
const workingSend: QueuedMessageTestRig['workingSend'] = () => rig.workingSend()
const settleAccepted: QueuedMessageTestRig['settleAccepted'] = (...args) =>
  rig.settleAccepted(...args)
const settleRejected: QueuedMessageTestRig['settleRejected'] = (...args) =>
  rig.settleRejected(...args)

describe('accept', () => {
  it('queues a capable send while the session owes work; an ordinary send still dispatches', async () => {
    await workingSend()
    const queued = await send('queued behind', 'queue-if-active').result
    expect(queued).toMatchObject({
      ok: true,
      value: { queued: { position: 1, state: 'waiting' } }
    })
    // The draft is not a submission, feeds no reducer, and owes no work.
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
    expect(await drafts()).toMatchObject([{ state: 'waiting' }])
  })

  it('replays the same queued answer for the same operation id', async () => {
    await workingSend()
    const body = hostTestMessage('queued behind')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      replayed: false,
      value: { queued: { state: 'waiting' } }
    })
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { state: 'waiting' } }
    })
    expect(await drafts()).toHaveLength(1)
  })

  it('routes an image send to the immediate path even while working (text-only v1)', async () => {
    await workingSend()
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'image-ref' as const, path: '/tmp/shot.png' }]
    }
    const clientOperationId = hostTestOperationId()
    const result = await host.send(CALLER, {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active'
    })
    expect(result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await drafts()).toHaveLength(0)
  })

  it('a send without the delivery field never queues, whatever the session is doing', async () => {
    await workingSend()
    const { result } = send('old client send')
    expect(await result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await drafts()).toHaveLength(0)
  })

  it('refuses past the draft-count budget with a readable message', async () => {
    await workingSend()
    for (let index = 0; index < 20; index += 1) {
      expect(await send(`draft ${index}`, 'queue-if-active').result).toMatchObject({ ok: true })
    }
    expect(await send('one too many', 'queue-if-active').result).toMatchObject({
      ok: false,
      refusal: { message: expect.stringContaining('queue is full') }
    })
  })
})

describe('drain', () => {
  it('drains a single draft when the owed work settles, and one of two drafts per settle (A1)', async () => {
    const working = await workingSend()
    const first = await send('first queued', 'queue-if-active').result
    const second = await send('second queued', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    const firstId = first.value.queued.messageId
    const secondId = second.value.queued.messageId
    await settleAccepted(working, 'a')
    // The drain converts the OLDEST actionable draft; the consumed submission
    // owes work again, which holds the second draft (one message per turn).
    await eventually(async () => expect(await rig.handoff(firstId)).toBeDefined())
    expect(await rig.handoff(secondId)).toBeUndefined()
    expect(await drafts()).toMatchObject([{ messageId: secondId, state: 'waiting' }])
    await settleAccepted(await rig.handoffId(firstId), 'b')
    await eventually(async () => expect(await rig.handoff(secondId)).toBeDefined())
    expect(await drafts()).toHaveLength(0)
  })

  it('takes no serialized drain step while the session is working, then drains when the work settles', async () => {
    const working = await workingSend()
    // Read only by a drain step, so it marks one.
    const step = vi.spyOn(JournalQueuedMessages.prototype, 'deliveredByEchoOwed')
    const queued = await send('waits for the turn', 'queue-if-active').result
    await send('and another', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    // Every wake during the turn is answered by the pre-check, not a step.
    expect(step).not.toHaveBeenCalled()
    await settleAccepted(working, 'a')
    const draftId = queued.value.queued.messageId
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    expect(step).toHaveBeenCalled()
  })

  it('a refused conversion returns the card with its stored reason, and an idle send overtakes a lone returned card (N1)', async () => {
    const working = await workingSend()
    const queued = await send('will be refused', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    // Classified like a rejected submission: from the fact, not the sentence.
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.[0]?.returnedRejection).toEqual({
      kind: 'providerRejected',
      detail: { text: 'provider refused this payload', audience: 'person' }
    })
    // The lone returned card traps nothing: a new capable send goes immediately.
    const overtaking = await send('sent past the card', 'queue-if-active').result
    expect(overtaking).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    // And the card still offers Send: a fresh submission id re-delivers it.
    const resent = await sendNow(draftId)
    expect(resent).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    if (!resent.ok || !('submission' in resent.value)) {
      throw new Error('expected the submission arm')
    }
    expect(resent.value.submission.clientMessageId).not.toBe(draftId)
    // The answer names the card it sent; clients read that, never id equality.
    expect(resent.value.submission.queuedMessageId).toBe(draftId)
    expect(await drafts()).toHaveLength(0)
    // Refused again: the card returns, matched through its current submission (N4).
    await settleRejected(resent.value.submission.clientMessageId, 'refused again')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
  })

  it('a skipped settlement hook heals on the next drain step, not only at the next open', async () => {
    const working = await workingSend()
    const queued = await send('refused while the hook fails', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hook = vi
      .spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction')
      .mockImplementationOnce(() => {
        throw new Error('bookkeeping failed')
      })
    try {
      await settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
      await eventually(async () =>
        expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
      )
    } finally {
      hook.mockRestore()
      warn.mockRestore()
    }
  })

  it('a waiting draft behind a returned card does not drain until the card is acted on (S5)', async () => {
    const working = await workingSend()
    const first = await send('to be refused', 'queue-if-active').result
    const second = await send('waits behind the card', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    await settleAccepted(working, 'a')
    const firstId = first.value.queued.messageId
    const secondId = second.value.queued.messageId
    await eventually(async () => expect(await rig.handoff(firstId)).toBeDefined())
    await settleRejected(await rig.handoffId(firstId), 'refused')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([
        { messageId: firstId, state: 'returned' },
        { messageId: secondId, state: 'waiting' }
      ])
    )
    // Deleting the card unblocks the one behind it.
    expect(await deleteQueued(firstId)).toMatchObject({ ok: true, value: { deleted: true } })
    await eventually(async () => expect(await rig.handoff(secondId)).toBeDefined())
  })
})

describe('held drafts', () => {
  it('a restart pauses the queue, reason restarted, and it survives a reopen; never auto-sent', async () => {
    const working = await workingSend()
    const queued = await send('written before the restart', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await rig.restartHostProcess()
    await settleAccepted(working, 'a')
    // The queue is paused, not the card: it carries no hold of its own.
    expect(await drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'restarted' })
    await host.close(SESSION, 'evict')
    expect(await rig.queuePause()).toEqual({ reason: 'restarted' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it("a restart's pause also lifts when the user's next send starts its turn, exactly like a Stop's", async () => {
    const working = await workingSend()
    const queued = await send('written before the restart', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await rig.restartHostProcess()
    await settleAccepted(working, 'a')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'restarted' })
    // The user's send starting its turn lifts it, and adopts the row into this instance.
    const next = send('user starts a new turn')
    await next.result
    expect(await rig.queuePause()).toEqual({ reason: 'restarted' })
    await settleAccepted(next.id, 'b')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('a failed conversion leaves the draft waiting and paused with its error; Send retries', async () => {
    const working = await workingSend()
    const queued = await send('conversion fails once', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const original = AgentSessionJournal.prototype.appendSubmission
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await settleAccepted(working, 'a')
      await eventually(async () =>
        expect(await drafts()).toMatchObject([
          { messageId: draftId, state: 'waiting', paused: true }
        ])
      )
    } finally {
      append.mockRestore()
    }
    expect(AgentSessionJournal.prototype.appendSubmission).toBe(original)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    // A marker the client localizes, never host-authored copy.
    expect(page.ok && page.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    // The marker is stored on the row, so a host restart keeps "Couldn't send"
    // instead of downgrading the card to a plain pause.
    rotateStructuredAgentSessionHostInstanceForTests()
    const restarted = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(restarted.ok && restarted.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    expect(await drafts()).toHaveLength(0)
  })
})

describe('Stop and Delete', () => {
  it('Stop pauses the queue — from ANY client — and the cards stay published; no text rides the answer', async () => {
    await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    // The Stop comes from a DIFFERENT client than the one that typed the
    // drafts: it must never move their text anywhere.
    const operationId = hostTestOperationId()
    const stopped = await stop(operationId, { callerKey: 'client-2' })
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(stopped.ok && Object.keys(stopped.value).sort()).toEqual(['cancelled'])
    expect(await drafts()).toEqual([
      { messageId: first.value.queued.messageId, state: 'waiting' },
      { messageId: second.value.queued.messageId, state: 'waiting' }
    ])
    // One pause for the whole queue: "Queue paused because you interrupted".
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    // A lost acknowledgement replays the settled Stop; still no text, no field.
    const replayed = await stop(operationId, { callerKey: 'client-2' })
    expect(replayed).toMatchObject({ ok: true, replayed: true, value: { cancelled: false } })
    expect(replayed.ok && Object.keys(replayed.value).sort()).toEqual(['cancelled'])
    expect(await drafts()).toHaveLength(2)
  })

  /** A draft consumed into a submission the delivery loop has not handed over:
   *  the loop is held at the child's start proof until the returned release. */
  async function consumedButNotHandedOver(): Promise<{ draftId: string; release: () => void }> {
    const working = await workingSend()
    const queued = await send('stopped in flight', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    let release: () => void = () => undefined
    awaitStarted.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    )
    await settleAccepted(working, 'a')
    const draftId = queued.value.queued.messageId
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    expect((await rig.handoff(draftId))?.handedOverAt).toBeUndefined()
    return { draftId, release: () => release() }
  }

  it("a Stop between consume and the agent's receipt sends the draft back to waiting, paused like the rest", async () => {
    const { draftId, release } = await consumedButNotHandedOver()
    const stopped = await stop()
    release()
    expect(stopped).toMatchObject({ ok: true })
    expect(await drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    // Nothing failed, so the card carries no refusal: it reads like any other paused card.
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const card = page.ok ? page.page.queuedMessages?.[0] : undefined
    expect(card).not.toHaveProperty('returnedReason')
    expect(card).not.toHaveProperty('returnedRejection')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('the Stop pause survives eviction and reopen, and Send-now overrides it', async () => {
    const working = await workingSend()
    const queued = await send('paused by stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await settleAccepted(working, 'a')
    // Evict the handle and reopen (the history read opens the conversation at
    // rest): the pause is derived from what the journal holds, so nothing drains.
    await host.close(SESSION, 'evict')
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    // Send-now overrides the pause — the user acting is a release.
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it("the user's next send lifts the stopped hold once its turn starts, and the held draft drains after that turn", async () => {
    const working = await workingSend()
    const queued = await send('paused by stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await stop()
    await settleAccepted(working, 'a')
    // Settling the stopped turn is not the user starting one: still paused.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    // The host accepting the send is not yet a turn: the pause lifts when the
    // provider accepts it, and the draft drains after that turn.
    const next = send('user starts a new turn')
    await next.result
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await settleAccepted(next.id, 'b')
    expect(await rig.queuePause()).toBeNull()
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('a host-internal send (orchestration mail, a restart continuation, a host-sent launch prompt) never lifts the pause', async () => {
    const working = await workingSend()
    const queued = await send('paused by stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await stop()
    await settleAccepted(working, 'a')
    // All three reach the host as a send the client send RPC did not make.
    const mail = send('coordinator mail', undefined, { internal: true })
    expect(await mail.result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    // The journal records who asked, which is what the pause reads.
    expect(await rig.submission(mail.id)).toMatchObject({ origin: 'host' })
    expect(await rig.submission(working)).toMatchObject({ origin: 'client' })
    await settleAccepted(mail.id, 'b')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it("a user send lifts nothing from a 'send_failed' hold — that card waits for its explicit Send", async () => {
    const working = await workingSend()
    const queued = await send('conversion fails once', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await settleAccepted(working, 'a')
      await eventually(async () =>
        expect(await drafts()).toMatchObject([
          { messageId: draftId, state: 'waiting', paused: true }
        ])
      )
    } finally {
      append.mockRestore()
    }
    const next = send('user starts a new turn')
    await next.result
    await settleAccepted(next.id, 'b')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    // The explicit Send is still the release.
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it('a Stop whose event fails to write still interrupts; only the pause is lost, and it is reported', async () => {
    await workingSend()
    const queued = await send('kept by the stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const record = vi
      .spyOn(AgentSessionJournal.prototype, 'appendStopEvent')
      .mockRejectedValueOnce(new Error('disk full'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
      expect(rig.cancelTurn).toHaveBeenCalledTimes(1)
      expect(warned).toHaveBeenCalledWith(
        expect.stringContaining("Stop's event row"),
        expect.anything()
      )
    } finally {
      record.mockRestore()
      warned.mockRestore()
    }
    expect(await rig.queuePause()).toBeNull()
    // The draft is intact (never withdrawn), merely unpaused.
    expect(await drafts()).toEqual([{ messageId: queued.value.queued.messageId, state: 'waiting' }])
  })

  it('Delete returns no body, replays from the receipt, and a fresh delete reports the disposition', async () => {
    await workingSend()
    const queued = await send('delete me', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const operationId = hostTestOperationId()
    const deleted = await deleteQueued(draftId, operationId)
    expect(deleted).toMatchObject({
      ok: true,
      replayed: false,
      value: { deleted: true, messageId: draftId }
    })
    // The card leaving the published list is the whole answer.
    expect(deleted.ok && Object.keys(deleted.value).sort()).toEqual(['deleted', 'messageId'])
    expect(await drafts()).toHaveLength(0)
    expect(await deleteQueued(draftId, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { deleted: true, messageId: draftId }
    })
    // A FRESH delete of the already-withdrawn draft reports the disposition.
    expect(await deleteQueued(draftId)).toMatchObject({
      ok: true,
      value: { deleted: false, disposition: 'withdrawn' }
    })
  })
})

describe('/clear', () => {
  function clear(clientOperationId: string) {
    const fields = { command: 'clear' as const }
    return host.conversationCommand(CALLER, {
      envelope: envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
    })
  }

  /** Two drafts paused by a Stop, then the work settled so command admission
   *  has nothing pending. */
  async function pausedDrafts(): Promise<[string, string]> {
    const working = await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    await stop()
    await settleAccepted(working, 'a')
    return [first.value.queued.messageId, second.value.queued.messageId]
  }

  it('the clear schema refuses the never-shipped withdraw opt-in', () => {
    const base = { envelope: envelope({}, 'agentSession.conversationCommand', 'op-schema') }
    expect(ConversationCommandParams.safeParse({ ...base, command: 'clear' }).success).toBe(true)
    expect(
      ConversationCommandParams.safeParse({ ...base, command: 'clear', withdrawQueued: true })
        .success
    ).toBe(false)
  })

  it('carries the drafts to the replacement session as visible cards on a paused queue — the same for every client', async () => {
    const [firstId, secondId] = await pausedDrafts()
    const operationId = hostTestOperationId()
    const cleared = await clear(operationId)
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    // The source's cards are spent tombstones; the replacement shows them on a
    // queue paused by the clear — not "because you interrupted" — until the user
    // acts: Resume, or their next send starting its turn.
    expect(await drafts()).toHaveLength(0)
    expect(await drafts(replacementId)).toEqual([
      { messageId: firstId, state: 'waiting' },
      { messageId: secondId, state: 'waiting' }
    ])
    expect(await rig.queuePause(replacementId)).toEqual({ reason: 'cleared' })
    // Paused from before the first carried card lands: the idle replacement auto-sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect((await host.journalSnapshot(replacementId)).submissions).toHaveLength(0)
    // A lost acknowledgement's replay re-runs nothing and duplicates nothing.
    const replayed = await clear(operationId)
    expect(replayed).toMatchObject({ ok: true, replayed: true })
    expect(await drafts(replacementId)).toHaveLength(2)
    // The carried card still answers Send-now, on the replacement.
    expect(await rig.sendNow(firstId, hostTestOperationId(), replacementId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it("carries who each card is from on its body, fingerprinted for the replacement's echo", async () => {
    const party = { address: 'term_peer', terminalHandle: 'term_peer', orcaSessionId: null }
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [{ party, name: 'Claude' }],
      orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
    }
    const working = await workingSend()
    await send('pointer', 'queue-if-active', { internal: true, from }).result
    await send('typed', 'queue-if-active').result
    await stop()
    await settleAccepted(working, 'a')
    const cleared = await clear(hostTestOperationId())
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    const rows =
      host.collaboratorsForTests().sessions.get(replacementId)?.journal.queuedMessages.list() ?? []
    expect(rows.map((row) => row.body.from)).toEqual([from, undefined])
    // The sender is outside the fingerprint, or the provider's echo of the text would not match.
    expect(rows[0]?.fingerprint).toBe(
      agentSessionSendBodyFingerprint(replacementId, hostTestMessage('pointer'))
    )
  })

  it("the replacement's 'cleared' pause lifts through Resume exactly like a Stop's", async () => {
    const [firstId] = await pausedDrafts()
    const cleared = await clear(hostTestOperationId())
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.queuePause(replacementId)).toEqual({ reason: 'cleared' })
    const resumed = await host.queuedMessagesResume(CALLER, {
      envelope: envelope(
        {},
        'agentSession.queuedMessagesResume',
        hostTestOperationId(),
        replacementId
      )
    })
    expect(resumed).toMatchObject({ ok: true, value: { resumed: true } })
    expect(await rig.queuePause(replacementId)).toBeNull()
    await eventually(async () =>
      expect(
        (await host.journalSnapshot(replacementId)).submissions.some(
          (entry) => entry.queuedMessageId === firstId
        )
      ).toBe(true)
    )
  })

  it('a carry whose insert fails leaves no pause over the empty replacement', async () => {
    await pausedDrafts()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const insert = vi
      .spyOn(JournalQueuedMessages.prototype, 'insert')
      .mockRejectedValueOnce(new Error('disk full'))
    let replacementId: string | undefined
    try {
      const cleared = await clear(hostTestOperationId())
      replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    } finally {
      insert.mockRestore()
      warned.mockRestore()
    }
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await drafts(replacementId)).toHaveLength(0)
    const journal = host.collaboratorsForTests().sessions.get(replacementId)?.journal
    expect(journal && structuredQueuePauses(journal)).toEqual([])
  })

  it('a returned card carries over as a plain waiting draft on the paused replacement', async () => {
    const working = await workingSend()
    const queued = await send('refused then cleared', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    const cleared = await clear(hostTestOperationId())
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    // The refusal belonged to the source's submissions; on the replacement the
    // text is simply a waiting draft again, behind the replacement's pause.
    expect(await drafts(replacementId)).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause(replacementId)).toEqual({ reason: 'cleared' })
    expect(await drafts()).toHaveLength(0)
  })

  it('a clear an older build left prepared holds no draft: it drains when the turn settles', async () => {
    const working = await workingSend()
    const queued = await send('behind the clear', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await store.setConversationCommand(SESSION, 1, {
      command: 'clear',
      runtimeFence: 1,
      operationId: hostTestOperationId(),
      callerKey: CALLER.callerKey,
      phase: 'prepared',
      state: 'unknown'
    })
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('a clear with no drafts carries nothing and answers exactly as before', async () => {
    const cleared = await clear(hostTestOperationId())
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    // Nothing to carry, so nothing opened the new conversation.
    expect(host.hasSession(replacementId)).toBe(false)
    expect(await drafts(replacementId)).toHaveLength(0)
  })
})

describe('publication', () => {
  async function subscribeEvents(): Promise<AgentSessionSubscribeEvent[]> {
    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'subscriber-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    return events
  }

  function queuedFrames(events: AgentSessionSubscribeEvent[]): AgentSessionQueuedMessage[][] {
    return events.flatMap((event) =>
      event.type !== 'end' && event.queuedMessages !== undefined && event.queuedMessages !== null
        ? [event.queuedMessages]
        : []
    )
  }

  it('hydrates the list on subscribe, publishes draft inserts at an unchanged cursor, and carries the shrunk list with the consumed submission in one frame', async () => {
    const working = await workingSend()
    const events = await subscribeEvents()
    // Hydration: the opening snapshot carries the (empty) list.
    expect(events[0]).toMatchObject({ type: 'snapshot', queuedMessages: [] })
    const queued = await send('queued behind', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    // The insert writes no journal row, yet the caught-up publish delivers it.
    await eventually(() => {
      const lists = queuedFrames(events)
      expect(lists.at(-1)).toMatchObject([{ messageId: draftId, state: 'waiting' }])
    })
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    // The frame that carries the consumed submission also carries the shrunk list.
    const consumeFrame = events.find(
      (event) =>
        event.type === 'batch' &&
        event.batch.submissions.some((entry) => entry.queuedMessageId === draftId)
    )
    expect(consumeFrame).toBeDefined()
    if (consumeFrame?.type === 'batch') {
      expect(consumeFrame.queuedMessages).toEqual([])
    }
  })

  it('a failed conversion reaches live subscribers as a paused card, with no further journal commit', async () => {
    const working = await workingSend()
    const events = await subscribeEvents()
    const queued = await send('conversion fails once', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await settleAccepted(working, 'a')
      await eventually(() =>
        expect(queuedFrames(events).at(-1)).toMatchObject([
          { messageId: draftId, paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
        ])
      )
    } finally {
      append.mockRestore()
    }
    // Send releases the process-level pause, which later tests' reused ids would otherwise inherit.
    expect(await sendNow(draftId)).toMatchObject({ ok: true })
  })

  it("live frames carry the queue's pause with the list, and Resume's lift", async () => {
    await workingSend()
    const events = await subscribeEvents()
    const queued = await send('paused by stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const pauses = () =>
      events.flatMap((event) =>
        event.type !== 'end' && event.queuePause !== undefined ? [event.queuePause] : []
      )
    await eventually(() => expect(pauses().at(-1)).toBeNull())
    await stop()
    await eventually(() => expect(pauses().at(-1)).toEqual({ reason: 'stopped' }))
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(() => expect(pauses().at(-1)).toBeNull())
  })

  it('an idle Stop that takes no effect pauses nothing', async () => {
    const working = await workingSend()
    const first = await send('to be refused', 'queue-if-active').result
    const second = await send('waits behind the card', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    const firstId = first.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(firstId)).toBeDefined())
    await settleRejected(await rig.handoffId(firstId), 'refused')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: firstId, state: 'returned' }, {}])
    )
    // Idle, nothing in flight and nothing withdrawn: the Stop changes nothing.
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await rig.queuePause()).toBeNull()
  })

  it('an unchanged list is not re-sent on later frames', async () => {
    await workingSend()
    const events = await subscribeEvents()
    await send('queued behind', 'queue-if-active').result
    await eventually(() => expect(queuedFrames(events).length).toBeGreaterThan(0))
    const framesAfterInsert = queuedFrames(events).length
    // Another journal commit with no draft change re-sends nothing.
    const { result } = send('another working send')
    await result
    await eventually(async () => {
      const last = events.at(-1)
      expect(last?.type).toBe('batch')
    })
    expect(queuedFrames(events).length).toBe(framesAfterInsert)
  })
})
