import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
import { MobileRelayRpcStreams } from '../transport/mobile-relay-rpc-streams'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { deriveHostFingerprint } from './push-host-fingerprint'

const fallback = vi.hoisted(() => ({
  token: vi.fn(),
  supported: vi.fn(),
  completion: { completed: Promise.resolve(true), signal: new AbortController().signal },
  eligible: vi.fn(),
  schedule: vi.fn(),
  preferences: { onlyWhenDesktopAway: true, sound: true, suppressWhileViewing: true }
}))
vi.mock('./push-token', () => ({ getDevicePushToken: fallback.token }))
vi.mock('./push-registration', () => ({
  getHostPushSupported: fallback.supported,
  getHostPushSupportCompletion: () => fallback.completion
}))
vi.mock('./push-receive', () => ({ canPresentForegroundPush: fallback.eligible }))
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: fallback.schedule }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(),
  DESKTOP_NOTIFICATION_CHANNEL_ID: 'orca-desktop'
}))
vi.mock('./notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: async () => fallback.preferences
}))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: async () => [
    { id: 'host-1', publicKeyB64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }
  ]
}))

vi.mock('./push-socket-dismissal', () => ({
  dismissHostPushNotification: vi.fn(async () => {})
}))
vi.mock('./push-dismissal-reconciliation', () => ({
  requestNotificationCatchup: vi.fn(async () => {})
}))
vi.mock('./notification-permissions', () => ({}))

type Handler = (data: unknown) => void

type SentFrame = { id: string; method: string; params: unknown }

function readSentFrame(request: unknown): SentFrame {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('id' in request) ||
    typeof request.id !== 'string' ||
    !('method' in request) ||
    typeof request.method !== 'string'
  ) {
    throw new Error('The stream registry sent a frame without a string id and method')
  }
  return {
    id: request.id,
    method: request.method,
    params: 'params' in request ? request.params : undefined
  }
}

function transportClient(subscribe: RpcClient['subscribe']) {
  const requests: { method: string; params: unknown }[] = []
  const client: RpcClient = {
    sendRequest: async (method, params) => {
      requests.push({ method, params })
      return { id: 'reply-1', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { requests, client }
}

// Use the real registry so transport owns dispose-before-ready cleanup.
function registryClient() {
  const sent: SentFrame[] = []
  let id = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++id}`,
    getState: () => 'connected',
    sendFrame: (request) => {
      sent.push(readSentFrame(request))
      return true
    }
  })
  return {
    registry,
    sent,
    ...transportClient((method, params, onData, options) =>
      registry.subscribe(method, params, onData, options)
    )
  }
}

function relayClient() {
  const sent: SentFrame[] = []
  let id = 0
  const streams = new MobileRelayRpcStreams({
    nextId: () => `relay-${++id}`,
    sendFrame: (frame) => {
      sent.push(readSentFrame(frame))
      return true
    },
    waitForConnected: async () => {}
  })
  return {
    streams,
    sent,
    ...transportClient((method, params, onData, options) =>
      streams.subscribe(method, params, onData, options)
    )
  }
}

function notificationReleases(rpc: {
  sent: SentFrame[]
  requests: { method: string; params: unknown }[]
}): unknown[] {
  return [...rpc.sent, ...rpc.requests]
    .filter((frame) => frame.method === 'notifications.unsubscribe')
    .map((frame) => frame.params)
}

function readyReply(id: string, subscriptionId: string): RpcResponse {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function client() {
  let handler: Handler | undefined
  return {
    getState: vi.fn(() => 'connected'),
    sendRequest: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn((_method: string, _params: unknown, callback: Handler) => {
      handler = callback
      return vi.fn()
    }),
    emit(data: unknown) {
      handler?.(data)
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fallback.token.mockResolvedValue({ platform: 'ios', token: 'apns' })
  fallback.supported.mockReturnValue(true)
  fallback.eligible.mockResolvedValue(true)
  fallback.schedule.mockResolvedValue('local')
  fallback.preferences = { onlyWhenDesktopAway: true, sound: true, suppressWhileViewing: true }
})

const liveAlert = {
  type: 'notification',
  source: 'agent-task-complete',
  title: 'Needs input',
  body: 'Reply',
  notificationId: 'agent-1',
  notificationEpoch: 'epoch-1',
  notificationSeq: 4,
  paneKey: 'pane-1',
  worktreeId: 'workspace-1',
  executionHost: 'runtime:ssh-1'
}

function emitAlert(event: unknown = liveAlert) {
  const rpc = registryClient()
  const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
  rpc.registry.handleResponse({
    id: rpc.sent[0]!.id,
    ok: true,
    streaming: true,
    result: event,
    _meta: { runtimeId: 'runtime-1' }
  })
  return stop
}

it.each([true, false, null])(
  'presents live alerts without a token (host push support %s)',
  async (support) => {
    fallback.token.mockResolvedValue(null)
    fallback.supported.mockReturnValue(support)
    emitAlert()
    await vi.waitFor(() => expect(fallback.schedule).toHaveBeenCalledOnce())
    expect(fallback.schedule.mock.calls[0][0]).toMatchObject({
      content: {
        title: 'Needs input',
        body: 'Reply',
        sound: 'default',
        data: {
          hostFingerprint: deriveHostFingerprint('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='),
          notificationId: 'agent-1',
          notificationEpoch: 'epoch-1',
          notificationSeq: 4,
          paneKey: 'pane-1',
          worktreeId: 'workspace-1',
          executionHost: 'runtime:ssh-1'
        }
      }
    })
  }
)

it('presents an unsupported host with a token, using the silent channel preference', async () => {
  fallback.supported.mockReturnValue(false)
  fallback.preferences.sound = false
  emitAlert()
  await vi.waitFor(() => expect(fallback.schedule).toHaveBeenCalledOnce())
  expect(fallback.schedule.mock.calls[0][0]).toMatchObject({
    content: { sound: false, data: { channelId: 'orca-desktop-silent' } },
    trigger: { channelId: 'orca-desktop-silent' }
  })
})

it.each([true, null])(
  'does not race push registration when a token exists (support %s)',
  async (support) => {
    fallback.supported.mockReturnValue(support)
    emitAlert()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fallback.schedule).not.toHaveBeenCalled()
  }
)

it.each([
  { desktopAllowed: false },
  { desktopAway: false },
  { source: 'test' },
  { agentState: 'working' }
])('applies push eligibility to desktop-suppressed stream frames %j', async (fields) => {
  fallback.token.mockResolvedValue(null)
  emitAlert({ ...liveAlert, ...fields })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fallback.schedule).not.toHaveBeenCalled()
})

it('delegates foreground eligibility before scheduling', async () => {
  fallback.token.mockResolvedValue(null)
  fallback.eligible.mockResolvedValue(false)
  emitAlert()
  await vi.waitFor(() => expect(fallback.eligible).toHaveBeenCalled())
  expect(fallback.schedule).not.toHaveBeenCalled()
})

it('does not schedule after a subscription is disposed during token lookup', async () => {
  let finish: (value: null) => void = () => {}
  fallback.token.mockReturnValue(
    new Promise<null>((resolve) => {
      finish = resolve
    })
  )
  const stop = emitAlert()
  stop()
  finish(null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fallback.schedule).not.toHaveBeenCalled()
})

it('uses an unsupported capability answer that arrives during token lookup', async () => {
  let finish: (value: { platform: string; token: string }) => void = () => {}
  fallback.supported.mockReturnValue(null)
  fallback.token.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  emitAlert()
  fallback.supported.mockReturnValue(false)
  finish({ platform: 'ios', token: 'apns' })
  await vi.waitFor(() => expect(fallback.schedule).toHaveBeenCalledOnce())
})

it('rechecks the device token during final fallback preparation', async () => {
  fallback.token.mockResolvedValueOnce(null).mockResolvedValue({ platform: 'ios', token: 'apns' })
  emitAlert()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fallback.schedule).not.toHaveBeenCalled()
})

it.each(['disposal', 'host-upgrade'])(
  'rechecks delivery authority after foreground eligibility (%s)',
  async (change) => {
    let finish: (eligible: boolean) => void = () => {}
    fallback.token.mockResolvedValue(null)
    if (change === 'host-upgrade') {
      fallback.supported.mockReturnValue(false)
      fallback.token.mockResolvedValue({ platform: 'ios', token: 'apns' })
    }
    fallback.eligible.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const stop = emitAlert()
    await vi.waitFor(() => expect(fallback.eligible).toHaveBeenCalledOnce())
    if (change === 'disposal') {
      stop()
    } else {
      fallback.supported.mockReturnValue(true)
    }
    finish(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fallback.schedule).not.toHaveBeenCalled()
  }
)

describe('subscribeToDesktopNotifications', () => {
  it('requests dismissal reconciliation on ready', async () => {
    const rpc = client()
    subscribeToDesktopNotifications(rpc as never, 'host-1')
    rpc.emit({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await Promise.resolve()
    expect(requestNotificationCatchup).toHaveBeenCalledWith(rpc, 'host-1', expect.any(Function))
    expect(dismissHostPushNotification).not.toHaveBeenCalled()
  })

  it('keeps socket dismissal processing active', async () => {
    const rpc = client()
    subscribeToDesktopNotifications(rpc as never, 'host-1')
    rpc.emit({ type: 'ready', subscriptionId: 'sub-1' })
    const dismissal = { type: 'dismiss', notificationId: 'agent-1', notificationSeq: 4 }
    rpc.emit(dismissal)
    await Promise.resolve()
    expect(dismissHostPushNotification).toHaveBeenCalledWith(dismissal, 'host-1')
  })

  it('releases the host stream once a ready lands after the disposer ran (direct)', () => {
    const rpc = registryClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    const subscribeFrame = rpc.sent[0]!
    expect(subscribeFrame.method).toBe('notifications.subscribe')

    stop()
    rpc.registry.handleResponse(readyReply(subscribeFrame.id, 'sub-1'))

    expect(requestNotificationCatchup).not.toHaveBeenCalled()
    expect(notificationReleases(rpc)).toEqual([{ subscriptionId: 'sub-1' }])
  })

  it('releases the host stream once a ready lands after the disposer ran (relay)', async () => {
    const rpc = relayClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    await Promise.resolve()
    const subscribeFrame = rpc.sent[0]!
    expect(subscribeFrame.method).toBe('notifications.subscribe')

    stop()
    rpc.streams.handleResponse(readyReply(subscribeFrame.id, 'sub-1'))

    expect(requestNotificationCatchup).not.toHaveBeenCalled()
    expect(notificationReleases(rpc)).toEqual([{ subscriptionId: 'sub-1' }])
  })

  it('closes the host stream once when the disposer runs after the ready reply (direct)', async () => {
    const rpc = registryClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    rpc.registry.handleResponse(readyReply(rpc.sent[0]!.id, 'sub-1'))

    stop()
    await Promise.resolve()

    expect(notificationReleases(rpc)).toEqual([{ subscriptionId: 'sub-1' }])
  })

  it('closes the host stream once when the disposer runs after the ready reply (relay)', async () => {
    const rpc = relayClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    await Promise.resolve()
    rpc.streams.handleResponse(readyReply(rpc.sent[0]!.id, 'sub-1'))

    stop()
    await Promise.resolve()

    expect(notificationReleases(rpc)).toEqual([{ subscriptionId: 'sub-1' }])
  })

  it('releases the replayed stream by its new id, never the one the closed socket assigned', () => {
    const rpc = registryClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    const subscribeFrame = rpc.sent[0]!
    rpc.registry.handleResponse(readyReply(subscribeFrame.id, 'sub-1'))

    rpc.registry.markForReplay()
    rpc.registry.replayAfterAuthentication()
    expect(rpc.sent[1]).toMatchObject({ id: subscribeFrame.id, method: 'notifications.subscribe' })
    stop()
    rpc.registry.handleResponse(readyReply(subscribeFrame.id, 'sub-2'))

    expect(notificationReleases(rpc)).toEqual([{ subscriptionId: 'sub-2' }])
  })

  it('catches up again when a replayed subscribe is ready', () => {
    const rpc = registryClient()
    subscribeToDesktopNotifications(rpc.client, 'host-1')
    const subscribeFrame = rpc.sent[0]!
    rpc.registry.handleResponse(readyReply(subscribeFrame.id, 'sub-1'))

    rpc.registry.markForReplay()
    rpc.registry.replayAfterAuthentication()
    rpc.registry.handleResponse(readyReply(subscribeFrame.id, 'sub-2'))

    expect(requestNotificationCatchup).toHaveBeenCalledTimes(2)
    expect(notificationReleases(rpc)).toEqual([])
  })
})
