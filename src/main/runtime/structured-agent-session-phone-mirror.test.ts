import { expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import {
  hostTestState,
  attach,
  envelope,
  CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import { createStructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'

it('uses actual receipt origin and live desktop proof, then retires only a genuine later live root', async () => {
  const h = hostTestState()
  await attach()
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(h.root)
  const sent: MobileNotificationEvent[] = []
  controller.onDispatched((event) => sent.push(event))
  let connected = true
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: true
    }),
    readWorkspaceLabels: () => ({}),
    isWorkspaceMuted: () => false,
    isConnectedDesktop: (id) => id === CALLER.callerKey && connected,
    dispatch: (event) => controller.dispatch(event),
    reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
    now: Date.now
  })
  const callers: (string | null)[] = []
  const stop = h.host.subscribeTurnCompletions({
    id: 'phone-mirror-flow',
    includePrompts: true,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      const caller = h.host.phoneAlertCaller(event)
      callers.push(caller)
      delivery.deliver(event, undefined, caller)
    },
    onState: delivery.reconcile,
    onTurnStarted: (id, cursor, floor) => controller.retireLiveStructuredTurn(id, cursor, floor)
  })
  const events = h.acquire.mock.calls.at(-1)![0].events
  if (!events) {
    throw new Error('Provider events were not installed')
  }
  const journal = h.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const notifications = () => sent.filter((event) => event.type === 'notification')
  const dismissals = () => sent.filter((event) => event.type === 'dismiss')
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    const command = envelope('agentSession.send', { body })
    expect(await h.host.send(CALLER, { envelope: command, body })).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(journal.submission(command.clientOperationId)?.dispatchState).toBe('accepted')
    )
    return command.clientOperationId
  }
  const writeTurn = async (id: string, clientMessageId: string, state: 'running' | 'completed') => {
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: id, ordinal: 0 }
    events.appendItem(
      identity,
      {
        kind: 'turn',
        turnId: id,
        state,
        userItemId: agentJournalSubmissionKey(clientMessageId),
        ...(state === 'completed' ? { outcome: 'success' as const } : {})
      },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
    )
    await h.host.flushStreamedEvents(SESSION)
  }
  try {
    const first = await send('From the connected desktop')
    await writeTurn('first', first, 'running')
    await writeTurn('first', first, 'completed')
    expect(callers).toEqual([CALLER.callerKey])
    expect(notifications()).toEqual([])
    connected = false
    const second = await send('Desktop disconnected before the news')
    await writeTurn('second', second, 'running')
    await writeTurn('second', second, 'completed')
    expect(notifications()).toHaveLength(1)
    const alert = notifications()[0]!
    const third = await send('Acceptance is not a start')
    expect(dismissals()).toEqual([])
    await writeTurn('third', third, 'running')
    expect(dismissals()).toEqual([
      expect.objectContaining({
        dismissedDelivery: {
          notificationId: alert.notificationId,
          notificationEpoch: alert.notificationEpoch,
          notificationSeq: alert.notificationSeq
        }
      })
    ])
    await writeTurn('third', third, 'completed')
    connected = true
    await writeTurn('unknown-origin', 'not-a-submission', 'running')
    await writeTurn('unknown-origin', 'not-a-submission', 'completed')
    expect(callers.at(-1)).toBeNull()
    expect(notifications()).toHaveLength(3)
    // The live registry dies on detach; historical delivery is left to ordinary dismissal.
    const count = dismissals().length
    stop()
    const restarted = new RuntimeMobileNotificationController()
    const restartedEvents: MobileNotificationEvent[] = []
    const stopRestarted = restarted.onDispatched((event) => restartedEvents.push(event))
    try {
      restarted.retireLiveStructuredTurn(SESSION, journal.cursor(), 0)
      expect(restartedEvents).toEqual([])
      expect(dismissals()).toHaveLength(count)
    } finally {
      stopRestarted()
      await restarted.closeDismissals()
    }
  } finally {
    stop()
    await controller.closeDismissals()
  }
})
