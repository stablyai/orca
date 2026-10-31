import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { ConversationCommandParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
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
import { holdDelivery } from './structured-agent-session-delivery-hold.test-fixture'

import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

let rig: QueuedMessageTestRig
let currentRig: QueuedMessageTestRig | undefined
const observationClock = createStructuredSessionObservationClock(() => rig.host, SESSION)
beforeEach(() => observationClock.start())
let host: QueuedMessageTestRig['host']
let dispatch: QueuedMessageTestRig['dispatch']

beforeEach(async () => {
  currentRig = undefined
  rig = await createQueuedMessageTestRig({ restartable: true })
  currentRig = rig
  ;({ host, dispatch } = rig)
})

afterEach(async () => {
  await observationClock.restoreBeforeCleanup(async () => {
    await currentRig?.dispose()
  })
})

const send: QueuedMessageTestRig['send'] = (...args) => rig.send(...args)
const drafts: QueuedMessageTestRig['drafts'] = (...args) => rig.drafts(...args)
const workingSend: QueuedMessageTestRig['workingSend'] = () => rig.workingSend()
const settleAccepted: QueuedMessageTestRig['settleAccepted'] = (...args) =>
  rig.settleAccepted(...args)

describe('accept', () => {
  it('queues a capable send while the session owes work; an ordinary send still dispatches', async () => {
    await workingSend()
    const queued = await send('queued behind', 'queue-if-active').result
    expect(queued).toMatchObject({
      ok: true,
      value: { queued: { position: 1, state: 'waiting' } }
    })
    // Drafts are not submissions and owe no execution work.
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
    expect(await drafts()).toMatchObject([{ state: 'waiting' }])
  })

  it('replays the same queued answer for the same operation id', async () => {
    await workingSend()
    const body = hostTestMessage('queued behind')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: rig.envelope(
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

  it('queues an image message in line behind text, and hands it over with its image', async () => {
    const working = await workingSend()
    const text = await send('text first', 'queue-if-active').result
    const body = hostTestMessage('and look at this')
    body.blocks.push({ type: 'image-ref', path: '/tmp/shot.png' })
    const fields = { body, delivery: 'queue-if-active' as const }
    const envelopeFields = rig.envelope(fields, 'agentSession.send', hostTestOperationId())
    const image = await host.send(CALLER, { envelope: envelopeFields, ...fields, userSend: true })
    if (!text.ok || !('queued' in text.value) || !image.ok || !('queued' in image.value)) {
      throw new Error('expected queued receipts')
    }
    const [textId, imageId] = [text.value.queued.messageId, image.value.queued.messageId]
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(textId)).toBeDefined())
    expect(await rig.handoff(imageId)).toBeUndefined()
    await settleAccepted(await rig.handoffId(textId), 'b')
    await eventually(async () => {
      const handedOver = await rig.handoffId(imageId)
      const sent = dispatch.mock.calls.find(([input]) => input.clientMessageId === handedOver)
      expect(sent?.[0].body.blocks).toEqual(body.blocks)
    })
  })

  it('a send without the delivery field never queues, whatever the session is doing', async () => {
    await workingSend()
    const { result } = send('old client send')
    expect(await result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await drafts()).toHaveLength(0)
  })

  it('accepts a human message beyond twenty retained drafts', async () => {
    await workingSend()
    for (let index = 0; index < 20; index += 1) {
      expect(await send(`draft ${index}`, 'queue-if-active').result).toMatchObject({ ok: true })
    }
    expect(await send('another message', 'queue-if-active').result).toMatchObject({
      ok: true,
      value: { queued: { position: 21, state: 'waiting' } }
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
    // Consume one oldest draft per turn; its new submission holds the next card.
    await eventually(async () => expect(await rig.handoff(firstId)).toBeDefined())
    expect(await rig.handoff(secondId)).toBeUndefined()
    expect(await drafts()).toMatchObject([{ messageId: secondId, state: 'waiting' }])
    await settleAccepted(await rig.handoffId(firstId), 'b')
    await eventually(async () => expect(await rig.handoff(secondId)).toBeDefined())
    expect(await drafts()).toHaveLength(0)
  })

  it('takes no serialized drain step while the session is working, then drains when the work settles', async () => {
    const working = await workingSend()
    // Only drain handoff invokes this consumability check.
    const step = vi.spyOn(JournalQueuedMessages.prototype, 'assertConsumable')
    const queued = await send('waits for the turn', 'queue-if-active').result
    await send('and another', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
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
    await rig.settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.[0]?.returnedRejection).toEqual({
      kind: 'providerRejected',
      detail: { text: 'provider refused this payload', audience: 'person' }
    })
    const overtaking = await send('sent past the card', 'queue-if-active').result
    expect(overtaking).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    const resent = await rig.sendNow(draftId)
    expect(resent).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    if (!resent.ok || !('submission' in resent.value)) {
      throw new Error('expected the submission arm')
    }
    expect(resent.value.submission.clientMessageId).not.toBe(draftId)
    // Match card linkage explicitly; draft and submission IDs differ.
    expect(resent.value.submission.queuedMessageId).toBe(draftId)
    expect(await drafts()).toHaveLength(0)
    await rig.settleRejected(resent.value.submission.clientMessageId, 'refused again')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
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
    await rig.settleRejected(await rig.handoffId(firstId), 'refused')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([
        { messageId: firstId, state: 'returned' },
        { messageId: secondId, state: 'waiting' }
      ])
    )
    expect(await rig.deleteQueued(firstId)).toMatchObject({ ok: true, value: { deleted: true } })
    await eventually(async () => expect(await rig.handoff(secondId)).toBeDefined())
  })
})

describe('held drafts', () => {
  it('a restart holds the queue without ever showing a pause, across a reopen; never auto-sent', async () => {
    const working = await workingSend()
    const queued = await send('written before the restart', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await rig.restartHostProcess()
    await settleAccepted(working, 'a')
    // Restart hold belongs to the queue and remains unpublished, with plain waiting cards.
    expect(await drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause()).toBeNull()
    await host.close(SESSION, 'evict')
    expect(await rig.queuePause()).toBeNull()
    await observationClock.observe(250)
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it("a restart's hold lifts when the user's next send starts its turn, exactly like a Stop's", async () => {
    const working = await workingSend()
    const queued = await send('written before the restart', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await rig.restartHostProcess()
    await settleAccepted(working, 'a')
    await observationClock.observe(250)
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.queuePause()).toBeNull()
    const next = send('user starts a new turn')
    await next.result
    expect(await rig.handoff(draftId)).toBeUndefined()
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
    expect(page.ok && page.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    // Journal the failure marker so reread retains the send-failed caption.
    const restarted = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(restarted.ok && restarted.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    expect(await drafts()).toHaveLength(0)
  })
})

describe('Stop and Delete', () => {
  it('Stop pauses the queue — from ANY client — and the cards stay published; no text rides the answer', async () => {
    const working = await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    // Another client’s Stop must never withdraw the drafts’ text.
    const operationId = hostTestOperationId()
    const stopped = await rig.stop(operationId, { callerKey: 'client-2' })
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(stopped.ok && Object.keys(stopped.value).sort()).toEqual(['cancelled'])
    expect(await drafts()).toEqual([
      { messageId: first.value.queued.messageId, state: 'waiting' },
      { messageId: second.value.queued.messageId, state: 'waiting' }
    ])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await host.collaboratorsForTests().serialize(SESSION, async () => {})
    const beforeReplay = await host.journalSnapshot(SESSION)
    const replayed = await rig.stop(operationId, { callerKey: 'client-2' })
    expect(replayed).toMatchObject({ ok: true, replayed: true, value: { cancelled: false } })
    expect(replayed.ok && Object.keys(replayed.value).sort()).toEqual(['cancelled'])
    expect(await drafts()).toEqual([
      { messageId: first.value.queued.messageId, state: 'waiting' },
      { messageId: second.value.queued.messageId, state: 'waiting' }
    ])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    const afterReplay = await host.journalSnapshot(SESSION)
    expect(afterReplay.items.filter((item) => item.body.kind === 'status')).toEqual(
      beforeReplay.items.filter((item) => item.body.kind === 'status')
    )
    expect(
      afterReplay.submissions.find((entry) => entry.clientMessageId === working)
    ).toMatchObject({ dispatchState: 'unknown', providerItemId: null })
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      page.ok && page.page.queuedMessages?.map(({ body, state }) => ({ body, state }))
    ).toEqual([
      { body: hostTestMessage('first text'), state: 'waiting' },
      { body: hostTestMessage('second text'), state: 'waiting' }
    ])
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.submissionBody(working)).toEqual(hostTestMessage('work on this'))
    expect(journal.queuedMessages.list().map((card) => card.options)).toEqual([{}, {}])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await rig.handoff(first.value.queued.messageId)).toBeUndefined()
    expect(await rig.handoff(second.value.queued.messageId)).toBeUndefined()
  })

  /** Hold delivery after draft consumption so intervening Stop can precede provider handover. */
  async function consumedButNotHandedOver(): Promise<{ draftId: string; release: () => void }> {
    const working = await workingSend()
    const queued = await send('stopped in flight', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const { release } = holdDelivery()
    await settleAccepted(working, 'a')
    const draftId = queued.value.queued.messageId
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    expect((await rig.handoff(draftId))?.handedOverAt).toBeUndefined()
    return { draftId, release }
  }

  it("a Stop between consume and the agent's receipt sends the draft back to waiting, paused like the rest", async () => {
    const { draftId, release } = await consumedButNotHandedOver()
    const stopping = rig.stop()
    release()
    const stopped = await stopping
    expect(stopped).toMatchObject({ ok: true })
    expect(await drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
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
    await rig.stop()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    await settleAccepted(working, 'a')
    // Reopen preserves the derived hold while hiding its pause row until new activity.
    await host.close(SESSION, 'evict')
    expect(await rig.queuePause()).toBeNull()
    const reopened = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(structuredQueuePauses(reopened).map((pause) => pause.reason)).toContain('stopped')
    await observationClock.observe(250)
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.sendNow(draftId)).toMatchObject({
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
    await rig.stop()
    await settleAccepted(working, 'a')
    await observationClock.observe(250)
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    // Host acceptance only hides the pause; provider turn acceptance lifts it.
    const next = send('user starts a new turn')
    await next.result
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.handoff(draftId)).toBeUndefined()
    await settleAccepted(next.id, 'b')
    expect(await rig.queuePause()).toBeNull()
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it("a host-internal send (orchestration mail, a restart continuation, a host-sent launch prompt) lifts the pause once accepted, like a person's", async () => {
    const working = await workingSend()
    const queued = await send('paused by stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await rig.stop()
    await settleAccepted(working, 'a')
    const mail = send('coordinator mail')
    expect(await mail.result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    await observationClock.observe(250)
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.handoff(draftId)).toBeUndefined()
    await settleAccepted(mail.id, 'b')
    expect(await rig.queuePause()).toBeNull()
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
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
    await observationClock.observe(250)
    expect(await rig.handoff(draftId)).toBeUndefined()
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    expect(await rig.sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it('a Stop whose acceptance fails to write interrupts nothing and pauses nothing', async () => {
    await workingSend()
    const queued = await send('kept by the stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const record = vi
      .spyOn(JournalStopAcceptor.prototype, 'accept')
      .mockRejectedValueOnce(new Error('disk full'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await rig.stop()).toMatchObject({
        ok: false,
        refusal: { details: { reason: 'stopFailed' } }
      })
      expect(rig.cancelTurn).not.toHaveBeenCalled()
      expect(warned).toHaveBeenCalledWith(
        expect.stringContaining('saving a Stop failed'),
        expect.anything()
      )
    } finally {
      record.mockRestore()
      warned.mockRestore()
    }
    expect(await rig.queuePause()).toBeNull()
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
    const deleted = await rig.deleteQueued(draftId, operationId)
    expect(deleted).toMatchObject({
      ok: true,
      replayed: false,
      value: { deleted: true, messageId: draftId }
    })
    expect(deleted.ok && Object.keys(deleted.value).sort()).toEqual(['deleted', 'messageId'])
    expect(await drafts()).toHaveLength(0)
    expect(await rig.deleteQueued(draftId, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { deleted: true, messageId: draftId }
    })
    expect(await rig.deleteQueued(draftId)).toMatchObject({
      ok: true,
      value: { deleted: false, disposition: 'withdrawn' }
    })
  })
})

describe('/clear', () => {
  function clear(clientOperationId: string) {
    const fields = { command: 'clear' as const }
    return host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
    })
  }

  async function pausedDrafts(): Promise<[string, string]> {
    const working = await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    await rig.stop()
    await settleAccepted(working, 'a')
    return [first.value.queued.messageId, second.value.queued.messageId]
  }

  it('the clear schema refuses the never-shipped withdraw opt-in', () => {
    const base = { envelope: rig.envelope({}, 'agentSession.conversationCommand', 'op-schema') }
    expect(ConversationCommandParams.safeParse({ ...base, command: 'clear' }).success).toBe(true)
    expect(
      ConversationCommandParams.safeParse({ ...base, command: 'clear', withdrawQueued: true })
        .success
    ).toBe(false)
  })

  it('preserves waiting cards in place and pauses them until user action for every client', async () => {
    const [firstId, secondId] = await pausedDrafts()
    const operationId = hostTestOperationId()
    const cleared = await clear(operationId)
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    const replacementId = cleared.ok ? SESSION : undefined
    if (!replacementId) {
      throw new Error('expected clear to succeed')
    }
    expect(await drafts(replacementId)).toEqual([
      { messageId: firstId, state: 'waiting' },
      { messageId: secondId, state: 'waiting' }
    ])
    expect(await rig.queuePause(replacementId)).toBeNull()
    // Hold the idle replacement before the first carried card arrives.
    await observationClock.observe(250)
    expect(
      (await host.journalSnapshot(replacementId)).submissions.filter(
        (entry) => entry.queuedMessageId !== undefined
      )
    ).toHaveLength(0)
    const replayed = await clear(operationId)
    expect(replayed).toMatchObject({ ok: true, replayed: true })
    expect(await drafts(replacementId)).toHaveLength(2)
    expect(await rig.sendNow(firstId, hostTestOperationId(), replacementId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it("preserves each card's sender and fingerprint across clear", async () => {
    const party = { address: 'term_peer', terminalHandle: 'term_peer', orcaSessionId: null }
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [{ party, name: 'Claude' }],
      orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
    }
    const working = await workingSend()
    await send('pointer', 'queue-if-active', { internal: true, from }).result
    await send('typed', 'queue-if-active').result
    await rig.stop()
    await settleAccepted(working, 'a')
    const cleared = await clear(hostTestOperationId())
    const replacementId = cleared.ok ? SESSION : undefined
    if (!replacementId) {
      throw new Error('expected clear to succeed')
    }
    const rows =
      host.collaboratorsForTests().sessions.get(replacementId)?.journal.queuedMessages.list() ?? []
    expect(rows.map((row) => row.body.from)).toEqual([from, undefined])
    // Exclude sender metadata so provider text echoes still match.
    expect(rows[0]?.fingerprint).toBe(
      agentSessionSendBodyFingerprint(replacementId, hostTestMessage('pointer'))
    )
  })

  it("the clear pause lifts through Resume exactly like a Stop's", async () => {
    const [firstId] = await pausedDrafts()
    const cleared = await clear(hostTestOperationId())
    const replacementId = cleared.ok ? SESSION : undefined
    if (!replacementId) {
      throw new Error('expected clear to succeed')
    }
    expect(await rig.queuePause(replacementId)).toBeNull()
    const resumed = await host.queuedMessagesResume(CALLER, {
      envelope: rig.envelope(
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

  it('clears without copying or inserting any queued card', async () => {
    const ids = await pausedDrafts()
    const insert = vi.spyOn(JournalQueuedMessages.prototype, 'insert')
    try {
      expect(await clear(hostTestOperationId())).toMatchObject({ ok: true })
      expect(insert).not.toHaveBeenCalled()
      expect((await drafts()).map((card) => card.messageId)).toEqual(ids)
    } finally {
      insert.mockRestore()
    }
  })

  it('preserves a returned card and its refusal after clear', async () => {
    const working = await workingSend()
    const queued = await send('refused then cleared', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(draftId), 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    const cleared = await clear(hostTestOperationId())
    const replacementId = cleared.ok ? SESSION : undefined
    if (!replacementId) {
      throw new Error('expected clear to succeed')
    }
    expect(await drafts(replacementId)).toEqual([{ messageId: draftId, state: 'returned' }])
    expect(await rig.queuePause(replacementId)).toBeNull()
  })

  it('a clear with no drafts keeps the existing conversation open', async () => {
    const cleared = await clear(hostTestOperationId())
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    const replacementId = cleared.ok ? SESSION : undefined
    if (!replacementId) {
      throw new Error('expected clear to succeed')
    }
    expect(host.hasSession(replacementId)).toBe(true)
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
    expect(events[0]).toMatchObject({ type: 'snapshot', queuedMessages: [] })
    const queued = await send('queued behind', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    // Publish the inserted queue transition to caught-up subscribers.
    await eventually(() => {
      const lists = queuedFrames(events)
      expect(lists.at(-1)).toMatchObject([{ messageId: draftId, state: 'waiting' }])
    })
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
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
    // Release process-local pause so reused fixture IDs cannot inherit it.
    expect(await rig.sendNow(draftId)).toMatchObject({ ok: true })
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
    await rig.stop()
    await eventually(() => expect(pauses().at(-1)).toEqual({ reason: 'stopped' }))
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(() => expect(pauses().at(-1)).toBeNull())
  })

  it('an idle Stop that takes no effect pauses nothing', async () => {
    const capabilities = host.deps.agents.capabilities('codex')
    if (!capabilities) {
      throw new Error('expected the queued test provider')
    }
    vi.spyOn(host.deps.agents, 'capabilities').mockReturnValue({
      ...capabilities,
      threadGoal: false
    })
    const working = await workingSend()
    const first = await send('to be refused', 'queue-if-active').result
    const second = await send('waits behind the card', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    const firstId = first.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(firstId)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(firstId), 'refused')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: firstId, state: 'returned' }, {}])
    )
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await rig.queuePause()).toBeNull()
  })

  it('an unchanged list is not re-sent on later frames', async () => {
    await workingSend()
    const events = await subscribeEvents()
    await send('queued behind', 'queue-if-active').result
    await eventually(() => expect(queuedFrames(events).length).toBeGreaterThan(0))
    const framesAfterInsert = queuedFrames(events).length
    const { result } = send('another working send')
    await result
    await eventually(async () => {
      const last = events.at(-1)
      expect(last?.type).toBe('batch')
    })
    expect(queuedFrames(events).length).toBe(framesAfterInsert)
  })
})
