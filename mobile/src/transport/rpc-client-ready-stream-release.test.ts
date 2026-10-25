import { describe, expect, it } from 'vitest'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import type { RpcSuccess } from './types'

type SentFrame = { id: string; method: string; params?: unknown }

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

function readyReply(id: string, subscriptionId: string): RpcSuccess {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId, snapshot: { accounts: [] } },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function directTransport() {
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
    sent,
    subscribe: (method: string) => registry.subscribe(method, null, () => {}),
    reply: (response: RpcSuccess) => registry.handleResponse(response)
  }
}

function relayTransport() {
  const sent: SentFrame[] = []
  let id = 0
  const streams = new MobileRelayRpcStreams({
    nextId: () => `relay-${++id}`,
    sendFrame: (frame) => {
      sent.push(frame)
      return true
    },
    waitForConnected: async () => {}
  })
  return {
    sent,
    subscribe: (method: string) => streams.subscribe(method, null, () => {}),
    reply: (response: RpcSuccess) => streams.handleResponse(response)
  }
}

describe.each(
  [
    ['accounts.subscribe', 'accounts.unsubscribe'],
    ['browser.screencast', 'browser.screencast.unsubscribe'],
    ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe'],
    ['notifications.subscribe', 'notifications.unsubscribe']
  ].flatMap(([method, release]) => [
    ['direct', method, release, directTransport] as const,
    ['relay', method, release, relayTransport] as const
  ])
)('%s transport releases %s through the ready id', (_name, method, release, transport) => {
  it('releases once after ready, and once when the dispose beat the ready', async () => {
    const afterReady = transport()
    const disposeAfterReady = afterReady.subscribe(method)
    await Promise.resolve()
    afterReady.reply(readyReply(afterReady.sent[0]!.id, 'host-id-1'))
    disposeAfterReady()

    const beforeReady = transport()
    const disposeBeforeReady = beforeReady.subscribe(method)
    await Promise.resolve()
    disposeBeforeReady()
    expect(beforeReady.sent).toHaveLength(1)
    beforeReady.reply(readyReply(beforeReady.sent[0]!.id, 'host-id-2'))

    expect(afterReady.sent.slice(1)).toEqual([
      expect.objectContaining({ method: release, params: { subscriptionId: 'host-id-1' } })
    ])
    expect(beforeReady.sent.slice(1)).toEqual([
      expect.objectContaining({ method: release, params: { subscriptionId: 'host-id-2' } })
    ])
  })
})
