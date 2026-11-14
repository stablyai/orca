import { describe, expect, it, vi } from 'vitest'

import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'

describe('MobileRelayRpcStreams failure parity', () => {
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
})
