import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
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

// Expose GC without execArgv so these cases run under the default pool and in mobile CI.
setFlagsFromString('--expose-gc')
const gc: () => void = globalThis.gc ?? runInNewContext('gc')

async function collectCallbacks(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    gc()
  }
}

function subscribeCapturedCallbacks(streams: MobileRelayRpcStreams) {
  const listenerPayload = new Uint8Array(1024 * 1024)
  const binaryPayload = new Uint8Array(1024 * 1024)
  const cancel = streams.subscribe('browser.screencast', {}, () => listenerPayload.byteLength, {
    onBinaryFrame: () => binaryPayload.byteLength
  })
  return {
    cancel,
    listener: new WeakRef(listenerPayload),
    binary: new WeakRef(binaryPayload)
  }
}

describe('mobile relay subscription cancellation', () => {
  it.each(['cancel', 'clear'] as const)(
    'releases callbacks on %s before their connection waiter settles',
    async (action) => {
      const wait = Promise.withResolvers<void>()
      const { streams, sendFrame } = createStreams(() => wait.promise)
      const captured = subscribeCapturedCallbacks(streams)
      try {
        await collectCallbacks()
        expect(captured.listener.deref()).toBeDefined()
        expect(captured.binary.deref()).toBeDefined()
        if (action === 'cancel') {
          captured.cancel()
        } else {
          streams.clear()
        }
        await collectCallbacks()
        expect(captured.listener.deref() === undefined).toBe(true)
        expect(captured.binary.deref() === undefined).toBe(true)
        expect(sendFrame).not.toHaveBeenCalled()
      } finally {
        wait.resolve()
        await wait.promise
        streams.clear()
      }
    }
  )

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
      // A non-slot param differs, which must not split the siblings.
      const cancelNewer = streams.subscribe(method, { ...params, limit: 5 }, newer)
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

  it('sends no terminal unsubscribe when the listener disposes on end', async () => {
    const { streams, sendFrame } = createStreams()
    const events: unknown[] = []
    let dispose = (): void => {}
    dispose = streams.subscribe(
      'terminal.subscribe',
      { terminal: 'term', client: { id: 'phone', type: 'mobile' } },
      (event) => {
        events.push(event)
        // The host already ended it; a slot-named unsubscribe would retire a newer same-slot stream.
        dispose()
      }
    )
    await Promise.resolve()

    expect(streams.handleResponse(response('request-1', { type: 'end' }))).toBe(true)
    dispose()

    expect(events).toEqual([{ type: 'end' }])
    expect(sendFrame).toHaveBeenCalledTimes(1)
  })

  it('orders same-slot terminal siblings by when they were sent, not when they subscribed', async () => {
    const connection = Promise.withResolvers<void>()
    let waits = 0
    // The first subscriber waits for the connection; the second is sent at once, so it is older.
    const { streams, sendFrame } = createStreams(() =>
      ++waits === 1 ? connection.promise : Promise.resolve()
    )
    const cancelSentLast = streams.subscribe(
      'terminal.subscribe',
      { terminal: 'term', client: { id: 'phone' }, viewport: { cols: 40, rows: 20 } },
      vi.fn()
    )
    const cancelSentFirst = streams.subscribe(
      'terminal.subscribe',
      { terminal: 'term', client: { id: 'phone' }, viewport: { cols: 60, rows: 30 } },
      vi.fn()
    )
    await Promise.resolve()
    connection.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(sendFrame.mock.calls.map(([request]) => request.id)).toEqual(['request-2', 'request-1'])

    cancelSentFirst()
    expect(sendFrame).toHaveBeenCalledTimes(2)
    cancelSentLast()
    expect(sendFrame).toHaveBeenCalledTimes(3)
    expect(sendFrame).toHaveBeenLastCalledWith({
      id: 'request-3',
      method: 'terminal.unsubscribe',
      params: { subscriptionId: 'term:phone', client: { id: 'phone' }, requestId: 'request-1' }
    })
  })

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
})
