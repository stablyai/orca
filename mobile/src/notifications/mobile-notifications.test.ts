import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
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

/** The real stream registry, so dispose-before-ready is answered by the transport, not by a fake. */
function registryClient() {
  const sent: SentFrame[] = []
  const requests: { method: string; params: unknown }[] = []
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
  const client: RpcClient = {
    sendRequest: async (method, params) => {
      requests.push({ method, params })
      return { id: 'reply-1', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe: (method, params, onData, options) =>
      registry.subscribe(method, params, onData, options),
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { registry, sent, requests, client }
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

  it('never runs the ready arm when the disposer ran before the reply landed', () => {
    const rpc = registryClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    const subscribeFrame = rpc.sent[0]!
    expect(subscribeFrame.method).toBe('notifications.subscribe')

    stop()
    rpc.registry.handleResponse(readyReply(subscribeFrame.id, 'sub-1'))

    expect(requestNotificationCatchup).not.toHaveBeenCalled()
    // The subscription id never reaches this module, so nothing closes the host's stream.
    expect(rpc.requests).toEqual([])
    expect(rpc.sent).toHaveLength(1)
  })

  it('closes the host stream when the disposer runs after the ready reply', async () => {
    const rpc = registryClient()
    const stop = subscribeToDesktopNotifications(rpc.client, 'host-1')
    rpc.registry.handleResponse(readyReply(rpc.sent[0]!.id, 'sub-1'))

    stop()
    await Promise.resolve()

    expect(rpc.requests).toEqual([
      { method: 'notifications.unsubscribe', params: { subscriptionId: 'sub-1' } }
    ])
  })
})
