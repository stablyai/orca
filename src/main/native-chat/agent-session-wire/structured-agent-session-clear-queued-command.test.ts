import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())

function command(name: 'clear' | 'compact') {
  const fields = {
    command: name,
    ...(name === 'compact' ? { delivery: 'queue-if-active' as const } : {})
  }
  return rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
}

it('clear refuses Working before releasing or cancelling its provider', async () => {
  await rig.workingSend()
  expect(await command('clear')).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'messagesUnsettled' } }
  })
  expect(rig.closeSession).not.toHaveBeenCalled()
  expect(rig.cancelTurn).not.toHaveBeenCalled()
  expect(rig.store.getRecord(SESSION)?.providerContextBoundary).toBeUndefined()
})

it('compact arriving during clear waits for its lane and is refused without a card or send', async () => {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'answer')
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  rig.closeSession.mockImplementationOnce(async () => {
    await held
    return true
  })
  const clearing = command('clear')
  await eventually(() => expect(rig.closeSession).toHaveBeenCalledOnce())
  let answered = false
  const compacting = command('compact').then((result) => {
    answered = true
    return result
  })
  try {
    await Promise.resolve()
    expect(answered).toBe(false)
  } finally {
    release()
  }
  expect(await clearing).toMatchObject({ ok: true })
  expect(await compacting).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'conversationCommandInFlight' } }
  })
  expect(await rig.drafts()).toEqual([])
  expect(rig.compact).not.toHaveBeenCalled()
  expect(rig.dispatch).toHaveBeenCalledOnce()
})

it('clear removes command cards from history and connected and reconnecting client snapshots', async () => {
  const working = await rig.workingSend()
  const first = rig.send('first', 'queue-if-active')
  await first.result
  const compact = await command('compact')
  if (!compact.ok || !compact.value.queued) {
    throw new Error('expected a command card')
  }
  const last = rig.send('last', 'queue-if-active')
  await last.result
  await rig.stop()
  await rig.settleAccepted(working, 'answer')
  const connected: AgentSessionSubscribeEvent[] = []
  await rig.host.subscribe({
    id: 'connected',
    sessionId: SESSION,
    emit: (event) => connected.push(event)
  })
  expect(await command('clear')).toMatchObject({ ok: true })
  const reconnecting: AgentSessionSubscribeEvent[] = []
  await rig.host.subscribe({
    id: 'reconnecting',
    sessionId: SESSION,
    emit: (event) => reconnecting.push(event)
  })
  const expected = [first.id, last.id].map((messageId) => ({ messageId, state: 'waiting' }))
  expect(await rig.drafts()).toEqual(expected)
  expect(await rig.queuePause()).toBeNull()
  expect(
    rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal.queuedMessages.pauses()
  ).toContainEqual(expect.objectContaining({ reason: 'cleared', messageIds: [first.id, last.id] }))
  for (const events of [connected, reconnecting]) {
    await eventually(() => {
      const cards = events
        .flatMap((event) =>
          event.type !== 'end' && event.queuedMessages ? [event.queuedMessages] : []
        )
        .at(-1)
      expect(cards?.map(({ messageId, state }) => ({ messageId, state }))).toEqual(expected)
    })
  }
  expect(await rig.handoff(compact.value.queued.messageId)).toBeUndefined()
  expect(rig.compact).not.toHaveBeenCalled()
  expect(rig.dispatch).toHaveBeenCalledOnce()
})
