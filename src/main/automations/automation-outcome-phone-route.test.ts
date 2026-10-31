import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { stubRuntime } from '../runtime/rpc/terminal-multiplex-test-harness'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { publishAutomationOutcome } from './automation-outcome-notification'
import type { RpcClient } from '../../../mobile/src/transport/rpc-client'
import { subscribeToDesktopNotifications } from '../../../mobile/src/notifications/mobile-notifications'
import { pushNotificationRouteData } from '../../../mobile/src/notifications/push-receive'
import { getNotificationNavigationTarget } from '../../../mobile/src/notifications/notification-routing'

const phone = vi.hoisted(() => ({
  present: vi.fn(),
  support: { completed: Promise.resolve(false), signal: new AbortController().signal },
  hosts: [{ id: 'phone-host', publicKeyB64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }]
}))
vi.mock('../../../mobile/src/notifications/push-token', () => ({
  getDevicePushToken: async () => null
}))
vi.mock('../../../mobile/src/notifications/push-registration', () => ({
  getHostPushSupported: () => false,
  getHostPushSupportCompletion: () => phone.support
}))
vi.mock('../../../mobile/src/notifications/notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: async () => ({
    onlyWhenDesktopAway: false,
    sound: false,
    suppressWhileViewing: false
  })
}))
vi.mock('../../../mobile/src/transport/host-store', () => ({
  loadHostCatalog: async () => phone.hosts
}))
vi.mock('../../../mobile/src/notifications/desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {},
  DESKTOP_NOTIFICATION_CHANNEL_ID: 'fixture'
}))
vi.mock('../../../mobile/src/notifications/android-foreground-push', () => ({
  presentForegroundPush: phone.present
}))
vi.mock('../../../mobile/src/notifications/push-socket-dismissal', () => ({
  dismissHostPushNotification: async () => {}
}))
vi.mock('../../../mobile/src/notifications/push-dismissal-reconciliation', () => ({
  requestNotificationCatchup: async () => {}
}))
vi.mock('../../../mobile/src/notifications/notification-permissions', () => ({}))
vi.mock('../../../mobile/src/notifications/push-dismissal-watermarks', () => ({
  wasPushDismissed: () => false
}))
vi.mock('../../../mobile/src/notifications/push-tray-dismissal', () => ({
  dismissPresentedPushNotification: async () => {}
}))
vi.mock('../../../mobile/src/notifications/notification-viewing-policy', () => ({
  shouldSuppressNotificationWhileViewing: () => false
}))
vi.mock('../../../mobile/src/storage/preferences', () => ({
  loadPushNotificationsEnabled: async () => true
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each([true, false])(
  'routes a produced failed outcome through the actual phone receiver to its destination (workspace=%s), without read acknowledgement',
  async (workspace) => {
    phone.present.mockClear()
    const { store } = await fixture()
    const automation = store.listAutomations()[0]
    const run = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
    store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed' })
    const seen = vi.spyOn(store, 'markAutomationRunSeen')
    const requests: string[] = []
    let receive: (event: unknown) => void = () => {}
    const client: RpcClient = {
      subscribe: (_method, _params, listener) => {
        receive = listener
        return () => {}
      },
      sendRequest: async (method) => {
        requests.push(method)
        return { id: 'reply', ok: true, result: {}, _meta: { runtimeId: 'host' } }
      },
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    const stopPhone = subscribeToDesktopNotifications(client, 'phone-host')
    const controller = new RuntimeMobileNotificationController()
    const stopHost = controller.onDispatched((event) => receive(event))
    const runtime = stubRuntime({
      dispatchMobileNotification: controller.dispatch.bind(controller),
      notifyAutomationsChanged: vi.fn()
    })
    try {
      publishAutomationOutcome(runtime, store, {
        settledRun: {
          name: 'Check',
          agentId: 'codex',
          run: {
            id: run.id,
            automationId: automation.id,
            status: 'dispatch_failed',
            sessionKind: 'chat',
            workspaceId: workspace ? 'workspace' : null,
            chatSessionId: workspace ? 'chat' : null,
            terminalPaneKey: null,
            terminalPtyId: null,
            dispatchedAt: workspace ? 2 : null,
            createdAt: 1
          }
        }
      })
      await vi.waitFor(() => expect(phone.present).toHaveBeenCalledOnce())
      const content: unknown = phone.present.mock.calls[0]?.[1]
      if (!content || typeof content !== 'object' || !('data' in content)) {
        throw new Error('Expected actual receiver route data')
      }
      const data = pushNotificationRouteData(content.data, phone.hosts, true)
      expect(
        getNotificationNavigationTarget(data, { knownHostIds: new Set(['phone-host']) })
      ).toEqual({
        hostId: 'phone-host',
        sessionTarget: workspace
          ? {
              name: '[hostId]/session/[worktreeId]',
              params: { hostId: 'phone-host', worktreeId: 'workspace' }
            }
          : null
      })
      expect(requests).not.toContain('automation.runSeen')
      expect(seen).not.toHaveBeenCalled()
      expect(
        store.listAutomationRuns().find((row) => row.id === run.id)?.failureSeenAt
      ).toBeUndefined()
    } finally {
      stopHost()
      stopPhone()
    }
  }
)
