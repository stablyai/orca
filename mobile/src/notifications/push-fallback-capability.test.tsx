import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY
} from './push-registration'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { NotificationDisplayTest } from '../settings/notification-display-test'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobilePushToken } from './push-token'

const native = vi.hoisted(() => {
  const clients: { hostId: string; state: string; client: RpcClient }[] = []
  return { token: vi.fn(), schedule: vi.fn(), eligible: vi.fn(), clients }
})
vi.mock('react-native', () => ({
  AppState: { currentState: 'background' },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} }
}))
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: native.schedule }))
vi.mock('./push-token', () => ({ getDevicePushToken: native.token }))
vi.mock('./push-receive', () => ({ canPresentForegroundPush: native.eligible }))
vi.mock('./push-dismissal-reconciliation', () => ({ requestNotificationCatchup: vi.fn() }))
vi.mock('./push-socket-dismissal', () => ({ dismissHostPushNotification: vi.fn() }))
vi.mock('../transport/use-all-host-clients', () => ({ useAllHostClients: () => native.clients }))
vi.mock('../mobile-web-shell/removed-host-shell-cache', () => ({
  deleteHostPageCache: vi.fn(),
  forgetHostUpdateFailures: vi.fn()
}))
vi.mock('../transport/host-descriptor-store', () => ({ forgetHostDescriptor: vi.fn() }))
vi.mock('../transport/host-store', () => ({
  removeHost: async () => {
    throw new Error('host metadata write failed')
  },
  loadHostCatalog: async () => [
    { id: 'host', publicKeyB64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' },
    { id: 'second', publicKeyB64: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=' }
  ]
}))
vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: async () => true,
  saveRemotePushHostRegistrations: async () => {},
  loadRemotePushHostRegistrations: async () => ({
    registeredHostIds: [],
    pendingUnregisterHostIds: []
  })
}))
vi.mock('./notification-permissions', () => ({
  getNotificationPermissionState: async () => ({ granted: true })
}))
vi.mock('./notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: async () => ({ onlyWhenDesktopAway: false, sound: true })
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {},
  DESKTOP_NOTIFICATION_CHANNEL_ID: 'orca-desktop'
}))

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function connection(hostId = 'host') {
  const status = deferred<RpcResponse>()
  let frame: (data: unknown) => void = () => {}
  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string): Promise<RpcResponse> =>
      method === 'status.get'
        ? status.promise
        : { id: 'test', ok: true, result: { accepted: true }, _meta: { runtimeId: 'runtime' } }
    ),
    subscribe: (_method, _params, handler) => {
      frame = handler
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const detach = attachPushRegistration(hostId, client)
  native.clients.push({ hostId, state: 'connected', client })
  return {
    client,
    detach,
    answer: (supported: boolean) =>
      status.resolve({
        id: 'status',
        ok: true,
        result: { capabilities: supported ? [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] : [] },
        _meta: { runtimeId: 'runtime' }
      }),
    emit: () =>
      frame({
        type: 'notification',
        source: 'agent-task-complete',
        title: 'Done',
        body: 'Reply',
        notificationId: 'alert',
        notificationEpoch: 'epoch',
        notificationSeq: 1,
        worktreeId: 'workspace'
      })
  }
}
let renderer: ReactTestRenderer | undefined
let stop: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  resetPushRegistrationForTests()
  native.token.mockReturnValue(new Promise(() => {}))
  native.schedule.mockResolvedValue('local')
  native.eligible.mockResolvedValue(true)
  native.clients = []
})
afterEach(async () => {
  stop?.()
  stop = undefined
  await act(async () => renderer?.unmount())
  renderer = undefined
  resetPushRegistrationForTests()
})
async function begin(route: string, rpc: ReturnType<typeof connection>) {
  if (route === 'live') {
    stop = subscribeToDesktopNotifications(rpc.client, 'host')
    rpc.emit()
  } else {
    await act(async () => {
      renderer = create(createElement(NotificationDisplayTest, { onTroubleshoot: vi.fn() }))
    })
    await act(async () => findAllByHostType(renderer!.root, 'Pressable')[0].props.onPress())
  }
  await vi.waitFor(() => expect(native.token).toHaveBeenCalled())
}
it.each(['live', 'settings'])(
  '%s releases a pending native token wait when the real host proves unsupported',
  async (route) => {
    const rpc = connection()
    await begin(route, rpc)
    await act(async () => rpc.answer(false))
    await vi.waitFor(() => expect(native.schedule).toHaveBeenCalledOnce())
    if (renderer) {
      expect(JSON.stringify(renderer.toJSON())).toContain('does not support push')
    }
  }
)
it.each(['live', 'settings'])(
  '%s keeps waiting for a no-token answer after the host proves supported',
  async (route) => {
    const token = deferred<MobilePushToken | null>()
    native.token.mockReturnValue(token.promise)
    const rpc = connection()
    await begin(route, rpc)
    await act(async () => rpc.answer(true))
    expect(native.schedule).not.toHaveBeenCalled()
    await act(async () => token.resolve(null))
    await vi.waitFor(() => expect(native.schedule).toHaveBeenCalledOnce())
  }
)
it.each(['live', 'settings'])(
  '%s cannot borrow unsupported capability from a replacement connection',
  async (route) => {
    const token = deferred<MobilePushToken | null>()
    native.token.mockReturnValue(token.promise)
    const rpc = connection()
    await begin(route, rpc)
    rpc.detach()
    const replacement = connection()
    await act(async () => {
      replacement.answer(false)
      token.resolve(null)
    })
    expect(native.schedule).not.toHaveBeenCalled()
  }
)

it('settings waits for every captured host to prove unsupported before bypassing a pending token', async () => {
  const first = connection()
  const second = connection('second')
  await begin('settings', first)
  await act(async () => first.answer(false))
  expect(native.schedule).not.toHaveBeenCalled()
  await act(async () => second.answer(false))
  await vi.waitFor(() => expect(native.schedule).toHaveBeenCalledOnce())
})
it('fences a retired connection after the final foreground policy completes', async () => {
  const eligibility = deferred<boolean>()
  native.eligible.mockReturnValue(eligibility.promise)
  const rpc = connection()
  rpc.answer(false)
  stop = subscribeToDesktopNotifications(rpc.client, 'host')
  rpc.emit()
  await vi.waitFor(() => expect(native.eligible).toHaveBeenCalledOnce())
  rpc.detach()
  const replacement = connection()
  await act(async () => replacement.answer(false))
  eligibility.resolve(true)
  rpc.emit()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(native.schedule).not.toHaveBeenCalled()
})

it('resumes fresh alerts after failed metadata removal without reviving an older pending alert', async () => {
  const token = deferred<MobilePushToken | null>()
  native.token.mockReturnValue(token.promise)
  const rpc = connection()
  await begin('live', rpc)
  const forgetClient = vi.fn()
  await expect(removeHostAndCloseClient('host', forgetClient)).rejects.toThrow(
    'host metadata write failed'
  )
  expect(forgetClient).not.toHaveBeenCalled()
  token.resolve(null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(native.schedule).not.toHaveBeenCalled()
  rpc.emit()
  await vi.waitFor(() => expect(native.schedule).toHaveBeenCalledOnce())
})
