import { describe, expect, it, vi } from 'vitest'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import type { RpcResponse } from './types'

function createStreams(waitForConnected = async () => {}) {
  let sequence = 0
  const sendFrame = vi.fn((_request: { id: string; method: string; params?: unknown }) => true)
  const streams = new MobileRelayRpcStreams({
    nextId: () => `request-${++sequence}`,
    sendFrame,
    waitForConnected
  })
  return { streams, sendFrame }
}

function response(id: string, result: unknown): RpcResponse {
  return { id, ok: true, streaming: true, result, _meta: { runtimeId: 'test' } }
}

const serverSubscriptions = [
  ['browser.screencast', 'browser.screencast.unsubscribe'],
  ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe']
] as const

describe('mobile relay subscription cancellation', () => {
  it.each(serverSubscriptions)('cleans up ready %s exactly once', async (method, unsubscribe) => {
    const { streams, sendFrame } = createStreams()
    const listener = vi.fn()
    const cancel = streams.subscribe(method, {}, listener)
    await Promise.resolve()
    streams.handleResponse(response('request-1', { type: 'ready', subscriptionId: 'server-1' }))
    cancel()
    cancel()
    expect(sendFrame.mock.calls).toEqual([
      [{ id: 'request-1', method, params: {} }],
      [{ id: 'request-2', method: unsubscribe, params: { subscriptionId: 'server-1' } }]
    ])
    expect(streams.handleResponse(response('request-1', { type: 'end' }))).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each(serverSubscriptions)(
    'cleans up late-ready %s without calling disposed listeners',
    async (method, unsubscribe) => {
      const { streams, sendFrame } = createStreams()
      const listener = vi.fn()
      const cancel = streams.subscribe(method, {}, listener)
      await Promise.resolve()
      cancel()
      cancel()
      expect(sendFrame).toHaveBeenCalledTimes(1)
      expect(streams.handleResponse(response('request-1', { type: 'starting' }))).toBe(true)
      streams.handleResponse(response('request-1', { type: 'ready', subscriptionId: 'server-1' }))
      expect(sendFrame).toHaveBeenLastCalledWith({
        id: 'request-2',
        method: unsubscribe,
        params: { subscriptionId: 'server-1' }
      })
      expect(
        streams.handleResponse(response('request-1', { type: 'ready', subscriptionId: 'server-1' }))
      ).toBe(false)
      expect(listener).not.toHaveBeenCalled()
    }
  )

  it.each(['error', 'end', 'disconnect', 'completed'])(
    'forgets cancelled cleanup routes on %s',
    async (ending) => {
      const { streams, sendFrame } = createStreams()
      const cancel = streams.subscribe('browser.screencast', {}, vi.fn())
      await Promise.resolve()
      cancel()
      if (ending === 'disconnect') {
        streams.clear()
      } else if (ending === 'completed') {
        streams.handleResponse({
          id: 'request-1',
          ok: true,
          result: null,
          _meta: { runtimeId: 'test' }
        })
      } else if (ending === 'error') {
        streams.handleResponse({
          id: 'request-1',
          ok: false,
          error: { code: 'unsupported', message: 'failed' },
          _meta: { runtimeId: 'test' }
        })
      } else {
        streams.handleResponse(response('request-1', { type: 'end', subscriptionId: 'server-1' }))
      }
      expect(
        streams.handleResponse(response('request-1', { type: 'ready', subscriptionId: 'server-1' }))
      ).toBe(false)
      expect(sendFrame).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'terminal.subscribe',
      { terminal: 'term', client: { id: 'phone' } },
      'terminal.unsubscribe',
      { subscriptionId: 'term:phone', client: { id: 'phone' } }
    ],
    [
      'session.tabs.subscribe',
      { worktree: 'id:workspace' },
      'session.tabs.unsubscribe',
      { worktree: 'id:workspace', subscriptionId: 'request-1' }
    ],
    [
      'nativeChat.subscribe',
      { subscriptionId: 'chat' },
      'nativeChat.unsubscribe',
      { subscriptionId: 'chat' }
    ]
  ])(
    'cancels %s using its request cleanup identity',
    async (method, params, unsubscribe, unsubscribeParams) => {
      const { streams, sendFrame } = createStreams()
      const cancel = streams.subscribe(method as string, params, vi.fn())
      await Promise.resolve()
      if (method === 'session.tabs.subscribe') {
        streams.handleResponse(response('request-1', { type: 'snapshot' }))
      }
      cancel()
      expect(sendFrame).toHaveBeenLastCalledWith({
        id: 'request-2',
        method: unsubscribe,
        params: unsubscribeParams
      })
    }
  )

  it.each([
    'terminal.subscribe',
    'browser.screencast',
    'runtime.clientEvents.subscribe',
    'session.tabs.subscribe',
    'nativeChat.subscribe'
  ])('does not unsubscribe an unsent %s', async (method) => {
    const wait = Promise.withResolvers<void>()
    const { streams, sendFrame } = createStreams(() => wait.promise)
    const cancel = streams.subscribe(
      method,
      { terminal: 'term', worktree: 'id:workspace', subscriptionId: 'chat' },
      vi.fn()
    )
    cancel()
    wait.resolve()
    await Promise.resolve()
    expect(sendFrame).not.toHaveBeenCalled()
    expect(
      streams.handleResponse(response('request-1', { type: 'ready', subscriptionId: 'server-1' }))
    ).toBe(false)
  })

  it.each([false, true])(
    'preserves a same-worktree sibling when cancellation precedes snapshot=%s',
    async (early) => {
      const { streams, sendFrame } = createStreams()
      const first = vi.fn()
      const second = vi.fn()
      const cancel = streams.subscribe(
        'session.tabs.subscribe',
        { worktree: 'id:workspace' },
        first
      )
      streams.subscribe('session.tabs.subscribe', { worktree: 'id:workspace' }, second)
      await Promise.resolve()
      if (early) {
        cancel()
      }
      expect(sendFrame).toHaveBeenCalledTimes(2)
      streams.handleResponse(response('request-1', { type: 'snapshot' }))
      if (!early) {
        cancel()
      }
      expect(sendFrame).toHaveBeenLastCalledWith({
        id: 'request-3',
        method: 'session.tabs.unsubscribe',
        params: { worktree: 'id:workspace', subscriptionId: 'request-1' }
      })
      streams.handleResponse(response('request-2', { type: 'snapshot' }))
      streams.handleResponse(response('request-2', { type: 'updated' }))
      expect(second).toHaveBeenCalledTimes(2)
      expect(first).toHaveBeenCalledTimes(early ? 0 : 1)
      expect(streams.handleResponse(response('request-1', { type: 'updated' }))).toBe(false)
    }
  )

  it.each([
    ['nativeChat.subscribe', { agent: 'claude', sessionId: 's1', subscriptionId: 'claude:s1' }],
    ['terminal.subscribe', { terminal: 'term', client: { id: 'phone' } }]
  ])(
    'keeps the newer %s live when an older same-token subscription unmounts',
    async (method, params) => {
      const { streams, sendFrame } = createStreams()
      const older = vi.fn()
      const newer = vi.fn()
      const cancelOlder = streams.subscribe(method, params, older)
      const cancelNewer = streams.subscribe(method, { ...params }, newer)
      await Promise.resolve()
      expect(sendFrame).toHaveBeenCalledTimes(2)
      cancelOlder()
      // The host keys cleanup by the deterministic token, so unsubscribing would evict the newer.
      expect(sendFrame).toHaveBeenCalledTimes(2)
      streams.handleResponse(response('request-2', { type: 'snapshot' }))
      expect(newer).toHaveBeenCalledTimes(1)
      expect(streams.handleResponse(response('request-1', { type: 'snapshot' }))).toBe(false)
      expect(older).not.toHaveBeenCalled()
      cancelNewer()
      expect(sendFrame).toHaveBeenCalledTimes(3)
      expect(sendFrame).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: method.replace(/\.subscribe$/, '.unsubscribe') })
      )
    }
  )

  it('still unsubscribes a shared-token nativeChat stream when the sibling is unsent', async () => {
    const wait = Promise.withResolvers<void>()
    let connected = false
    const { streams, sendFrame } = createStreams(() =>
      connected ? Promise.resolve() : wait.promise
    )
    const params = { agent: 'claude', sessionId: 's1', subscriptionId: 'claude:s1' }
    connected = true
    const cancelOlder = streams.subscribe('nativeChat.subscribe', params, vi.fn())
    await Promise.resolve()
    connected = false
    streams.subscribe('nativeChat.subscribe', params, vi.fn())
    cancelOlder()
    expect(sendFrame).toHaveBeenCalledTimes(2)
    expect(sendFrame).toHaveBeenLastCalledWith({
      id: 'request-3',
      method: 'nativeChat.unsubscribe',
      params: { subscriptionId: 'claude:s1' }
    })
  })

  it('cleans up every cancelled server subscription across repeated late-ready cycles', async () => {
    const { streams, sendFrame } = createStreams()
    const listener = vi.fn()
    for (let i = 0; i < 100; i++) {
      const cancel = streams.subscribe('runtime.clientEvents.subscribe', {}, listener)
      await Promise.resolve()
      const requestId = `request-${2 * i + 1}`
      cancel()
      streams.handleResponse(response(requestId, { type: 'ready', subscriptionId: `server-${i}` }))
    }
    expect(
      sendFrame.mock.calls.filter(
        ([request]) => (request as { method: string }).method === 'runtime.clientEvents.unsubscribe'
      )
    ).toHaveLength(100)
    expect(listener).not.toHaveBeenCalled()
  })
})
