import { describe, expect, it, vi } from 'vitest'
import { createMobileWorkspaceReviewStatus } from '../session/mobile-workspace-review-status'
import { stubRpcClient } from './rpc-client-test-stub'
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
    subscribe: (
      method: string,
      params: unknown = null,
      listener: (value: unknown) => void = () => {}
    ) => registry.subscribe(method, params, listener),
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
    subscribe: (
      method: string,
      params: unknown = null,
      listener: (value: unknown) => void = () => {}
    ) => streams.subscribe(method, params, listener),
    reply: (response: RpcSuccess) => streams.handleResponse(response)
  }
}

describe.each(
  [
    ['accounts.subscribe', 'accounts.unsubscribe'],
    ['browser.screencast', 'browser.screencast.unsubscribe'],
    ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe'],
    ['notifications.subscribe', 'notifications.unsubscribe'],
    ['worktree.review.subscribe', 'worktree.review.unsubscribe']
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
    disposeAfterReady()
    afterReady.reply(readyReply(afterReady.sent[0]!.id, 'host-id-1'))

    const beforeReady = transport()
    const disposeBeforeReady = beforeReady.subscribe(method)
    await Promise.resolve()
    disposeBeforeReady()
    disposeBeforeReady()
    expect(beforeReady.sent).toHaveLength(1)
    beforeReady.reply(readyReply(beforeReady.sent[0]!.id, 'host-id-2'))
    beforeReady.reply(readyReply(beforeReady.sent[0]!.id, 'host-id-2'))
    disposeBeforeReady()

    expect(afterReady.sent.slice(1)).toEqual([
      expect.objectContaining({ method: release, params: { subscriptionId: 'host-id-1' } })
    ])
    expect(beforeReady.sent.slice(1)).toEqual([
      expect.objectContaining({ method: release, params: { subscriptionId: 'host-id-2' } })
    ])
  })
})

describe.each([
  ['direct', directTransport],
  ['relay', relayTransport]
] as const)('%s review status transport ownership', (_name, transport) => {
  it.each([false, true])(
    'releases exactly once with cancellation before ready=%s',
    async (early) => {
      const wire = transport()
      const sendRequest = vi.fn()
      const status = createMobileWorkspaceReviewStatus()
      const client = stubRpcClient({ subscribe: wire.subscribe, sendRequest })
      const dispose = status.start(client, 'wt-1', true)
      try {
        await Promise.resolve()
        const request = wire.sent[0]!
        expect(request).toMatchObject({
          method: 'worktree.review.subscribe',
          params: { worktree: 'id:wt-1' }
        })
        if (early) {
          dispose()
        }
        wire.reply(readyReply(request.id, 'review-lease'))
        const snapshot: RpcSuccess = {
          ...readyReply(request.id, 'review-lease'),
          result: {
            type: 'snapshot',
            subscriptionId: 'review-lease',
            worktreeId: 'wt-1',
            branch: 'feature',
            fetchedAt: 1,
            stale: false,
            review: {
              number: 42,
              state: 'merged',
              checksStatus: 'success',
              title: 'Feature',
              url: 'https://github.com/a/b/pull/42'
            }
          }
        }
        wire.reply(snapshot)
        expect(status.getSnapshot().glyph).toBe(early ? 'branch' : 'merge')
        dispose()
        dispose()
        status.reset()
        wire.reply(snapshot)
        expect(status.getSnapshot().label).toContain('unknown')
        expect(wire.sent.slice(1)).toEqual([
          expect.objectContaining({
            method: 'worktree.review.unsubscribe',
            params: { subscriptionId: 'review-lease' }
          })
        ])
        expect(sendRequest).not.toHaveBeenCalled()
      } finally {
        dispose()
      }
    }
  )
})
