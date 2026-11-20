import { expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { createQueuedMessageTestRig } from './host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from './host/testing/structured-agent-session-host-test-data.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeAndCodexDeclared } from './providers/testing/structured-agent-session-adapter-router.test-fixture'

it('holds a revoked queued request before handoff, including explicit Send after restart', async () => {
  let allowed = true
  const guard = vi.fn(() => {
    if (!allowed) {
      throw new Error('membership ended')
    }
  })
  const rig = await createQueuedMessageTestRig({
    hostDeps: { assertQueuedMessageAllowed: guard },
    restartable: true
  })
  try {
    const working = await rig.workingSend()
    const queued = rig.send('old group request', 'queue-if-active')
    expect(await queued.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    allowed = false
    await rig.settleAccepted(working, 'first')
    await eventually(() => expect(guard).toHaveBeenCalled())
    expect(await rig.handoff(queued.id)).toBeUndefined()
    expect(await rig.drafts()).toMatchObject([
      { messageId: queued.id, state: 'waiting', paused: true }
    ])
    await rig.restartHostProcess()
    await expect(rig.sendNow(queued.id)).rejects.toThrow('membership ended')
    expect(await rig.handoff(queued.id)).toBeUndefined()
    allowed = true
    expect(await rig.sendNow(queued.id)).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(queued.id)).toBeDefined())
  } finally {
    await rig.dispose()
  }
})

it('hands over only the card its guard passed, and holds the one it refuses', async () => {
  let armed = false
  let first = ''
  let second = ''
  const checked: string[] = []
  const rig = await createQueuedMessageTestRig({
    hostDeps: {
      assertQueuedMessageAllowed: (_session, id) => {
        if (!armed) {
          return
        }
        checked.push(id)
        if (id === second) {
          throw new Error('revoked request must not execute')
        }
        if (id === first && checked.length === 1) {
          // A withdraw asked while the guard runs lands after the claim it guards.
          const session = [...rig.host.collaboratorsForTests().sessions.values()][0]!
          void session.journal.queuedMessages.withdraw([first]).catch(() => {})
        }
      }
    }
  })
  try {
    const working = await rig.workingSend()
    const allowed = rig.send('allowed request', 'queue-if-active')
    await allowed.result
    first = allowed.id
    const revoked = rig.send('revoked request', 'queue-if-active')
    await revoked.result
    second = revoked.id
    armed = true
    await rig.settleAccepted(working, 'first')
    // The card the guard passed is the one handed over; the refused one never is.
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(first), 'allowed')
    await eventually(async () =>
      expect(await rig.drafts()).toMatchObject([{ messageId: second, paused: true }])
    )
    expect(checked).toEqual([first, second])
    expect(await rig.handoff(second)).toBeUndefined()
  } finally {
    await rig.dispose()
  }
})

it('withdraws mail its owner no longer owes instead of holding it on the admission guard', async () => {
  const from: AgentMessageSource = {
    kind: 'agent',
    senders: [],
    orchestration: { message: 'mail-notice', mailbox: 'peer', dispatchId: null, messages: [] }
  }
  const guard = vi.fn(() => {
    throw new Error('This group request or member is no longer active.')
  })
  const rig = await createQueuedMessageTestRig({
    hostDeps: { assertQueuedMessageAllowed: guard, queuedAgentMessageOwed: () => 'stale' }
  })
  try {
    const working = await rig.workingSend()
    const pressed = rig.send('stopped request mail', 'queue-if-active', { internal: true, from })
    const drained = rig.send('more stopped mail', 'queue-if-active', { internal: true, from })
    await pressed.result
    await drained.result
    // Send withdraws the stale mail it was pressed on; the drain after the turn withdraws the rest.
    expect(await rig.sendNow(pressed.id)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'continuationSuperseded' } }
    })
    await rig.settleAccepted(working, 'done')
    await eventually(async () => expect(await rig.drafts()).toEqual([]))
    expect(guard).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})

it('tells each message it takes once: an opener at once, a queued one only when handed over', async () => {
  const admitted: { body: AgentJournalMessageItem; joinsRunningTurn: boolean }[] = []
  const rig = await createQueuedMessageTestRig({
    hostDeps: { onMessageAdmitted: (message) => admitted.push(message) }
  })
  try {
    const working = await rig.workingSend()
    const queued = rig.send('next turn', 'queue-if-active')
    await queued.result
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatchObject({
      body: hostTestMessage('work on this'),
      joinsRunningTurn: false
    })

    await rig.settleAccepted(working, 'first')
    await eventually(() => expect(admitted).toHaveLength(2))
    expect(admitted[1]).toMatchObject({
      body: hostTestMessage('next turn'),
      joinsRunningTurn: false
    })
  } finally {
    await rig.dispose()
  }
})

it("keeps other agents' mail out of a turn its provider can join only by cancelling, then sends it once", async () => {
  const agents = claudeAndCodexDeclared()
  const declared = agents.capabilities.bind(agents)
  // ACP agents declare this: their steer cancels the running prompt, so Orca holds the input.
  agents.capabilities = (agent) => {
    const capabilities = declared(agent)
    return capabilities && { ...capabilities, steering: 'queue' }
  }
  const from: AgentMessageSource = {
    kind: 'agent',
    senders: [],
    orchestration: { message: 'mail-notice', mailbox: 'peer', dispatchId: null, messages: [] }
  }
  const rig = await createQueuedMessageTestRig({ hostDeps: { agents } })
  const turn = (state: 'running' | 'completed') =>
    rig
      .providerEvents()
      .appendItem(
        { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-first', ordinal: 99 },
        { kind: 'turn', turnId: 'turn-first', state },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
  try {
    await rig.settleAccepted(await rig.workingSend(), 'first')
    turn('running')
    await rig.host.flushStreamedEvents(SESSION)
    await rig.send('status mail', 'queue-if-active', { internal: true, from }).result
    await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
    expect(rig.dispatch).toHaveBeenCalledOnce()
    expect(await rig.drafts()).toHaveLength(1)
    turn('completed')
    await rig.host.flushStreamedEvents(SESSION)
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    expect(await rig.drafts()).toEqual([])
  } finally {
    await rig.dispose()
  }
})
