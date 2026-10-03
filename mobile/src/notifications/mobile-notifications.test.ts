import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
import { MobileRelayRpcStreams } from '../transport/mobile-relay-rpc-streams'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

vi.mock('./push-socket-dismissal', () => ({
  dismissHostPushNotification: vi.fn(async () => {})
}))
vi.mock('./push-dismissal-reconciliation', () => ({
  requestNotificationCatchup: vi.fn(async () => {})
}))
vi.mock('./notification-permissions', () => ({}))

type Handler = (data: unknown) => void

type SentFrame = { id: string; method: string; params: unknown }

/** The registry sends through an `unknown` port, so name the shape the assertions read. */
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

/** The real stream registry, so dispose-before-ready is answered by the transport, not by a fake. */
function registryClient() {
  const sent: SentFrame[] = []
  let id = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++id}`,
    deviceToken: 'device-token',
    getState: () => 'connected',
    sendEncrypted: (request) => {
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

/** The real relay stream manager, the other transport a paired phone reaches a host through. */
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

/** Every `notifications.unsubscribe` the phone put on the wire, by either route. */
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

beforeEach(() => vi.clearAllMocks())

describe('subscribeToDesktopNotifications', () => {
  it('never presents an OS banner for socket alert or replay events', async () => {
    const rpc = client()
    subscribeToDesktopNotifications(rpc as never, 'host-1')
    rpc.emit({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    rpc.emit({
      type: 'notification',
      notificationId: 'agent-1',
      title: 'Needs input',
      body: 'Reply',
      source: 'agent-task-complete'
    })
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
