import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcSuccess } from './types'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'

function rpcFailure(id: string): RpcFailure {
  return {
    id,
    ok: false,
    error: { code: 'unsupported', message: 'Unknown method' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('MobileRelayRpcStreams failure parity', () => {
  it('emits an RPC failure exactly once before removing the stream', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    await Promise.resolve()

    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(true)
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: 'Unknown method',
      error: { code: 'unsupported', message: 'Unknown method' }
    })
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    cancel()
    expect(sendFrame).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'an error reply',
      (streams: MobileRelayRpcStreams) => streams.handleResponse(rpcFailure('stream-1'))
    ],
    ['a send failure', () => undefined]
  ])(
    'sends no terminal unsubscribe when the listener disposes on %s',
    async (label, failStream) => {
      const sendFrame = vi.fn(() => label !== 'a send failure')
      const streams = new MobileRelayRpcStreams({
        nextId: () => 'stream-1',
        sendFrame,
        waitForConnected: async () => {}
      })
      const events: unknown[] = []
      let dispose = (): void => {}
      dispose = streams.subscribe(
        'terminal.subscribe',
        { terminal: 'term', client: { id: 'phone', type: 'mobile' } },
        (event) => {
          events.push(event)
          dispose()
        }
      )
      await Promise.resolve()
      failStream(streams)
      dispose()

      expect(events).toEqual([expect.objectContaining({ type: 'error' })])
      expect(sendFrame).toHaveBeenCalledTimes(1)
    }
  )

  it('emits a connection-wait rejection exactly once without sending or cancelling', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const waitError = new Error('relay session closed')
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: () => Promise.reject(waitError)
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: 'relay session closed',
      error: waitError
    })
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    cancel()
    expect(sendFrame).not.toHaveBeenCalled()
  })

  it('emits a send failure exactly once and fences cancellation and late frames', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => false)
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: 'Connection interrupted',
      error: undefined
    })
    cancel()
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    expect(sendFrame).toHaveBeenCalledTimes(1)
  })

  it('does not emit a failure after the caller cancels a queued stream', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const connection = Promise.withResolvers<void>()
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: () => connection.promise
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    cancel()
    connection.reject(new Error('late failure'))
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(sendFrame).not.toHaveBeenCalled()
  })

  it('does not send or emit after session clear settles a connection wait', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const connection = Promise.withResolvers<void>()
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: () => connection.promise
    })
    streams.subscribe('session.tabs.subscribe', { worktree: 'id:worktree-1' }, listener)
    streams.clear()
    connection.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(sendFrame).not.toHaveBeenCalled()
  })

  it('removes a failed stream even when its listener throws', async () => {
    const listener = vi.fn(() => {
      throw new Error('listener failed')
    })
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame: () => true,
      waitForConnected: async () => {}
    })
    streams.subscribe('session.tabs.subscribe', { worktree: 'id:worktree-1' }, listener)
    await Promise.resolve()

    expect(() => streams.handleResponse(rpcFailure('stream-1'))).toThrow('listener failed')
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

function readyReply(id: string): RpcSuccess {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId: 'sub-1' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('MobileRelayRpcStreams cancel fencing', () => {
  function subscribed() {
    const listener = vi.fn()
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame: vi.fn(() => true),
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(
      'notifications.subscribe',
      { includeDesktopSuppressed: true },
      listener
    )
    return { listener, streams, cancel }
  }

  it('delivers a ready reply to a live subscription', async () => {
    const { listener, streams } = subscribed()
    await Promise.resolve()

    expect(streams.handleResponse(readyReply('stream-1'))).toBe(true)
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'ready', subscriptionId: 'sub-1' })
  })

  it('drops a ready reply that lands after the caller cancelled', async () => {
    const { listener, streams, cancel } = subscribed()
    await Promise.resolve()

    cancel()

    expect(streams.handleResponse(readyReply('stream-1'))).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })
})
