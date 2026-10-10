import { describe, expect, it, vi } from 'vitest'
import {
  hostTestState,
  adapter,
  attach,
  seedApproval,
  envelope,
  CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { claudeAndCodexDeclared } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import { createStructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'

function wire(host: StructuredAgentSessionHost, controller: RuntimeMobileNotificationController) {
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: []
    }),
    readWorkspaceLabels: () => ({}),
    dispatch: (event) => controller.dispatch(event),
    reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
    now: () => NOW
  })
  return host.subscribeTurnCompletions({
    id: 'host-attention-delivery',
    includePrompts: true,
    emit: (event) => {
      if (event.type !== 'end') {
        delivery.deliver(event, host.readStatusSummary(SESSION))
      }
    },
    onState: delivery.reconcile
  })
}

describe('prompt delivery after host recovery', () => {
  it('withdraws a recovered cancellation before the first attention baseline', async () => {
    const h = hostTestState()
    await attach()
    const original = new RuntimeMobileNotificationController()
    original.configureDismissalStore(h.root)
    const sent: MobileNotificationEvent[] = []
    original.onDispatched((event) => sent.push(event))
    const unsubscribe = wire(h.host, original)
    const body = hostTestMessage('Work')
    expect(
      await h.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
    const prompt = await seedApproval()
    const delivered = sent.find((event) => event.type === 'notification')
    if (
      !delivered?.notificationId ||
      !delivered.notificationEpoch ||
      delivered.notificationSeq === undefined
    ) {
      throw new Error('pending approval was not delivered')
    }
    const identity = {
      notificationId: delivered.notificationId,
      notificationEpoch: delivered.notificationEpoch,
      notificationSeq: delivered.notificationSeq
    }
    unsubscribe()
    // The dismissal record is written asynchronously; restart once it is durable.
    await vi.waitFor(() =>
      expect(
        new MobileNotificationDismissalStore(h.root).liveDeliveries(identity.notificationId)
      ).toHaveLength(1)
    )
    const restarted = new RuntimeMobileNotificationController()
    restarted.configureDismissalStore(h.root)
    const events: MobileNotificationEvent[] = []
    restarted.onDispatched((event) => events.push(event))
    const store = await openTestAgentSessionRecordStore(h.root)
    const host = new StructuredAgentSessionHost({
      agents: claudeAndCodexDeclared(),
      logger: h.log.logger,
      store,
      adapter: adapter(),
      journalDatabase: openTestJournalHostDatabase(h.root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-b',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => NOW
    })
    const stop = wire(host, restarted)
    try {
      await host.reconcileRestartLeases()
      await host.restoreReadableSessions()
      const history = await host.history({ sessionId: SESSION, direction: 'tail' })
      expect(history.ok).toBe(true)
      expect(
        history.ok ? history.page.items.find((item) => item.itemId === prompt.itemId)?.body : null
      ).toMatchObject({ resolution: { state: 'cancelled' } })
      expect(events.filter((event) => event.type === 'notification')).toEqual([])
      expect(events.filter((event) => event.type === 'dismiss')).toEqual([
        expect.objectContaining({ dismissedDelivery: identity })
      ])
      await vi.waitFor(() =>
        expect(
          new MobileNotificationDismissalStore(h.root).liveDeliveries(identity.notificationId)
        ).toEqual([])
      )
      expect(restarted.reconcileDismissedPushes([identity])).toEqual([identity])
      await host.restoreReadableSessions()
      expect(events.filter((event) => event.type === 'dismiss')).toHaveLength(1)
    } finally {
      stop()
      await host.flushAllStreamedEvents()
    }
  })
})
