// Editing a queued card in place, through the real host, journal and drain: Save keeps the card's
// identity, an edit lease stops automatic delivery at the card (and so at everything behind it),
// and no lease outlives its deadline, its card, or its conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import { shouldQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import { QUEUED_MESSAGES_PUBLISHED_MAX_BYTES } from './structured-agent-session-queued-published-bytes'
import { QUEUED_MESSAGE_EDIT_LEASE_MS } from '../agent-session-journal/queued-message-edit-leases'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())

function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!value) {
    throw new Error('missing test conversation')
  }
  return value
}
async function queue(text: string, options?: { internal: true }) {
  const result = await rig.send(text, 'queue-if-active', options).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('not queued')
  }
  return result.value.queued.messageId
}
function fingerprint(id: string) {
  const card = journal().queuedMessages.get(id)
  if (!card) {
    throw new Error('missing card')
  }
  return card.fingerprint
}
function update(messageId: string, expected: string, text: string, operationId?: string) {
  const fields = { messageId, expectedBodyFingerprint: expected, text }
  return rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(
      fields,
      'agentSession.queuedMessageUpdate',
      operationId ?? hostTestOperationId()
    ),
    ...fields
  })
}
function hold(
  messageId: string,
  action: 'acquire' | 'renew' | 'release' = 'acquire',
  editId = 'edit-1',
  caller = QUEUED_RIG_CALLER
) {
  const common = { sessionId: HOST_TEST_SESSION, messageId, editId }
  return rig.host.queuedMessageEditHold(
    caller,
    action === 'acquire'
      ? { ...common, action, expectedBodyFingerprint: fingerprint(messageId) }
      : { ...common, action }
  )
}
function publication() {
  return readQueuePublication(journal(), structuredQueueSendGate(rig.store, HOST_TEST_SESSION))
}
function published(id: string) {
  return publication().queuedMessages.find((message) => message.messageId === id)
}
function held() {
  return [...journal().queuedMessages.editLeases.heldIds()]
}

describe('saving a queued card in place', () => {
  it('keeps id, position and sender; text that reads like a command stays text', async () => {
    await rig.workingSend()
    const from = { kind: 'agent' as const, senders: [], orchestration: null }
    const queued = await rig.send('original', 'queue-if-active', { internal: true, from }).result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('not queued')
    }
    const id = queued.value.queued.messageId
    const before = journal().queuedMessages.get(id)!
    expect(await update(id, before.fingerprint, '/compact')).toMatchObject({
      ok: true,
      value: { status: 'updated' }
    })
    const body = { ...before.body, blocks: [{ type: 'text' as const, text: '/compact' }] }
    expect(journal().queuedMessages.get(id)).toEqual({
      ...before,
      body,
      fingerprint: agentSessionSendBodyFingerprint(HOST_TEST_SESSION, body)
    })
    expect(published(id)?.body).toEqual(body)
  })

  it('a resent Save reads the card as it stands and never overwrites newer text', async () => {
    await rig.workingSend()
    const id = await queue('base')
    const base = fingerprint(id)
    const operation = hostTestOperationId()
    expect(await update(id, base, 'mine', operation)).toMatchObject({
      value: { status: 'updated' }
    })
    expect(await update(id, base, 'mine', operation)).toMatchObject({
      value: { status: 'unchanged' }
    })
    expect(await update(id, fingerprint(id), 'newer')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(await update(id, base, 'mine', operation)).toMatchObject({
      value: { status: 'changed' }
    })
    expect(await update(id, base, 'another draft')).toMatchObject({
      value: { status: 'changed' }
    })
    expect(journal().queuedMessages.get(id)?.body.blocks).toEqual([{ type: 'text', text: 'newer' }])
  })

  it('after Send or Delete elsewhere, Save answers gone and recreates nothing', async () => {
    await rig.workingSend()
    const deleted = await queue('deleted')
    const sent = await queue('sent')
    const bases = [fingerprint(deleted), fingerprint(sent)] as const
    await rig.deleteQueued(deleted)
    await rig.sendNow(sent)
    expect(await update(deleted, bases[0], 'edit')).toMatchObject({
      value: { status: 'gone', disposition: 'withdrawn' }
    })
    expect(await update(sent, bases[1], 'edit')).toMatchObject({
      value: { status: 'gone', disposition: 'dispatched' }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('counts the edited card once against the queue size bound', async () => {
    await rig.workingSend()
    const big = await queue('x'.repeat(QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - 120 * 1024))
    const small = await queue('small')
    expect(await update(small, fingerprint(small), 'y'.repeat(200 * 1024))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'queueTooLarge' } }
    })
    expect(journal().queuedMessages.get(small)?.body.blocks).toEqual([
      { type: 'text', text: 'small' }
    ])
    expect(await update(big, fingerprint(big), 'z'.repeat(250 * 1024))).toMatchObject({
      ok: true,
      value: { status: 'updated' }
    })
  })

  it('a command card is not editable', async () => {
    await rig.workingSend()
    const body = { ...hostTestMessage('/compact'), command: { name: 'compact' } }
    const command = await journal().queuedMessages.insert({
      messageId: 'command-card',
      body,
      fingerprint: agentSessionSendBodyFingerprint(HOST_TEST_SESSION, body),
      hostInstance: 'host'
    })
    expect(await hold(command.messageId)).toEqual({ status: 'not-editable' })
    expect(await update(command.messageId, command.fingerprint, 'text')).toMatchObject({
      value: { status: 'not-editable' }
    })
  })
})

describe('edit leases and automatic delivery', () => {
  it('earlier cards deliver; the edited card and those behind it wait; a new send still queues', async () => {
    const work = await rig.workingSend()
    const first = await queue('first')
    const edited = await queue('edited')
    const last = await queue('last')
    expect(await hold(edited)).toMatchObject({ status: 'held', leaseDurationMs: 120_000 })
    expect(held()).toEqual([edited])
    expect(published(edited)?.paused).toBeUndefined()
    await rig.settleAccepted(work, 'work-done')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(first), 'first-done')
    expect(publication().nextQueuedMessageId).toBeNull()
    expect(journal().queuedMessages.get(edited)?.state).toBe('waiting')
    expect(journal().queuedMessages.get(last)?.state).toBe('waiting')
    expect(
      shouldQueueStructuredAgentSessionSend({
        journal: journal(),
        ...structuredQueueSendGate(rig.store, HOST_TEST_SESSION)()
      })
    ).toBe(true)
    // An explicit Send still overrides, and spends the lease with the card.
    expect(await rig.sendNow(edited)).toMatchObject({ ok: true })
    expect(journal().queuedMessages.editLeases.heldIds().size).toBe(0)
  })

  it('Save then release lets the edited card drain with its new text', async () => {
    const work = await rig.workingSend()
    const id = await queue('before')
    await hold(id)
    await rig.settleAccepted(work, 'work-done')
    expect(await update(id, fingerprint(id), 'after')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(held()).toEqual([])
    await hold(id, 'release')
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    const submissions = (await rig.host.journalSnapshot(HOST_TEST_SESSION)).submissions
    expect(submissions.at(-1)?.payloadFingerprint).toBe(
      agentSessionSendBodyFingerprint(HOST_TEST_SESSION, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'after' }]
      })
    )
  })

  it("one editor's release keeps another's hold; a renewal re-sends nothing and is not activity", async () => {
    await rig.workingSend()
    const id = await queue('base')
    await hold(id)
    await hold(id, 'acquire', 'edit-1', { callerKey: 'phone' })
    const before = publication()
    const touch = vi.spyOn(rig.host.collaboratorsForTests().sessions, 'touch')
    expect(await hold(id, 'renew')).toMatchObject({ status: 'held' })
    // An open editor does not keep the agent's process from its idle stop.
    expect(touch).not.toHaveBeenCalled()
    expect(publication()).toBe(before)
    expect(await hold(id, 'release')).toEqual({ status: 'released' })
    expect(held()).toEqual([id])
    await hold(id, 'release', 'edit-1', { callerKey: 'phone' })
    expect(held()).toEqual([])
  })

  it('acquiring after delivery won answers gone; Save without a lease still works', async () => {
    await rig.workingSend()
    const id = await queue('base')
    expect(await update(id, fingerprint(id), 'saved')).toMatchObject({
      value: { status: 'updated' }
    })
    await rig.sendNow(id)
    expect(
      await rig.host.queuedMessageEditHold(QUEUED_RIG_CALLER, {
        sessionId: HOST_TEST_SESSION,
        messageId: id,
        editId: 'late',
        action: 'acquire',
        expectedBodyFingerprint: 'f'.repeat(64)
      })
    ).toEqual({ status: 'gone' })
  })

  it('a lapsed lease wakes delivery with no journal activity, even when publishing fails', async () => {
    const work = await rig.workingSend()
    const id = await queue('edited')
    let clock = 0
    const time = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await hold(id)
      await rig.settleAccepted(work, 'work-done')
      await vi.advanceTimersByTimeAsync(0)
      expect(publication().nextQueuedMessageId).toBeNull()
      const publish = vi
        .spyOn(rig.host.collaboratorsForTests().subscribers, 'publish')
        .mockImplementationOnce(() => {
          throw new Error('publication failed')
        })
      clock = QUEUED_MESSAGE_EDIT_LEASE_MS
      await vi.advanceTimersByTimeAsync(QUEUED_MESSAGE_EDIT_LEASE_MS)
      publish.mockRestore()
      vi.useRealTimers()
      await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    } finally {
      vi.useRealTimers()
      time.mockRestore()
    }
  })

  it('Stop and Resume leave the edit hold alone and never publish it as a pause', async () => {
    await rig.workingSend()
    const id = await queue('base')
    await hold(id)
    await rig.stop()
    await rig.resume()
    expect(held()).toEqual([id])
    expect(published(id)?.paused).toBeUndefined()
    expect(publication().nextQueuedMessageId).toBeNull()
  })

  it('an edit open across /clear keeps its hold and saves into the same card', async () => {
    const working = await rig.workingSend()
    const id = await queue('before clear')
    await hold(id)
    await rig.stop()
    await rig.settleAccepted(working, 'answer')
    const fields = { command: 'clear' as const }
    expect(
      await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    expect(held()).toEqual([id])
    expect(await update(id, fingerprint(id), 'after clear')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(published(id)?.body.blocks).toEqual([{ type: 'text', text: 'after clear' }])
    expect(publication().queuePause).toBeNull()
    expect(journal().queuedMessages.get(id)?.state).toBe('waiting')
  })

  it('release never opens a closed conversation; closing drops every lease', async () => {
    await rig.workingSend()
    const id = await queue('base')
    await hold(id)
    const leases = journal().queuedMessages.editLeases
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    expect(leases.heldIds([]).size).toBe(0)
    expect(await hold(id, 'release')).toEqual({ status: 'released' })
    expect(rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)).toBeUndefined()
  })
})
