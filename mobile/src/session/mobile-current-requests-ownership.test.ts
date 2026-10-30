import { afterEach, expect, it, vi } from 'vitest'
import { readMobileCurrentRequests } from './mobile-structured-agent-session-rpc'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'

afterEach(() => vi.useRealTimers())

it.each([10, 100])(
  'keeps actual phone correlations finite across %i disposed read views and drains to a current sibling',
  async (count) => {
    vi.useFakeTimers()
    const frames: RpcRequestFrame[] = []
    let sequence = 0
    const tracker = new RpcClientRequestTracker({
      nextId: () => String(++sequence),
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendFrame: (frame) => {
        frames.push(frame)
        return true
      }
    })
    const client: RpcClient = {
      sendRequest: (method, params, options) => tracker.sendRequest(method, params, options),
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => tracker.rejectAll('closed')
    }
    const captured = scopeRpcClientToExecutionHost(client, 'runtime:host-a')
    const sibling = scopeRpcClientToExecutionHost(client, 'runtime:host-b')
    const operations: Promise<unknown>[] = []
    const request = { sessionId: 'portable-chat', version: 'old', cursor: 0 }
    const disposed = new AbortController()
    operations.push(
      readMobileCurrentRequests(
        captured,
        'host-a',
        'agentSession.currentRequests',
        request,
        disposed.signal
      ).catch((error) => error)
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.size()).toBe(1)
    disposed.abort()
    for (let i = 0; i < count; i++) {
      const view = new AbortController()
      operations.push(
        readMobileCurrentRequests(
          captured,
          'host-a',
          'agentSession.currentRequests',
          { ...request, version: `obsolete-${i}` },
          view.signal
        ).catch((error) => error)
      )
      view.abort()
    }
    await vi.advanceTimersByTimeAsync(1_000)
    const current = readMobileCurrentRequests(captured, 'host-a', 'agentSession.currentRequests', {
      ...request,
      version: 'current'
    })
    operations.push(current)
    const other = readMobileCurrentRequests(
      sibling,
      'host-b',
      'agentSession.currentRequests',
      request
    )
    operations.push(other)
    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.size()).toBe(2)
    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => frame.envelope?.executionHost)).toEqual([
      'runtime:host-a',
      'runtime:host-b'
    ])
    const reply = { marker: { version: 'current' }, json: '[]', nextCursor: null }
    tracker.resolve({ id: frames[1].id, ok: true, result: reply, _meta: { runtimeId: 'host-b' } })
    await expect(other).resolves.toBe(reply)
    await vi.advanceTimersByTimeAsync(13_999)
    expect(frames).toHaveLength(2)
    expect(tracker.size()).toBe(1)
    // The disposed operation still owns its actual slot until its connect-inclusive deadline.
    await vi.advanceTimersByTimeAsync(1)
    expect(frames).toHaveLength(3)
    expect(frames[2].params).toMatchObject({ version: 'current' })
    expect(frames[2].envelope?.executionHost).toBe('runtime:host-a')
    expect(tracker.size()).toBe(1)
    expect(frames.some((frame) => JSON.stringify(frame.params).includes('obsolete-'))).toBe(false)
    tracker.resolve({ id: frames[2].id, ok: true, result: reply, _meta: { runtimeId: 'host-a' } })
    await expect(current).resolves.toBe(reply)
    await Promise.all(operations)
    expect(tracker.size()).toBe(0)
    const dead = new AbortController()
    const first = readMobileCurrentRequests(
      captured,
      'host-a',
      'agentSession.currentRequests',
      request
    ).catch((error) => error)
    const queued = readMobileCurrentRequests(
      captured,
      'host-a',
      'agentSession.currentRequests',
      request,
      dead.signal
    ).catch((error) => error)
    dead.abort()
    await vi.advanceTimersByTimeAsync(15_000)
    await Promise.all([first, queued])
    expect(tracker.size()).toBe(0)
    expect(frames).toHaveLength(4)
    client.close()
  }
)

it('includes a real queued phone read in its total fifteen-second operation budget', async () => {
  vi.useFakeTimers()
  let sequence = 0
  const frames: RpcRequestFrame[] = []
  let connection: 'connected' | 'disconnected' = 'connected'
  const connect = vi.fn(async () => {})
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++sequence),
    getState: () => connection,
    waitForConnected: connect,
    sendFrame: (frame) => {
      frames.push(frame)
      return true
    }
  })
  const client: RpcClient = {
    sendRequest: (method, params, options) => tracker.sendRequest(method, params, options),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => tracker.rejectAll('closed')
  }
  const request = { sessionId: 'portable-chat', version: 'old', cursor: 0 }
  const old = readMobileCurrentRequests(
    client,
    'host-a',
    'agentSession.currentRequests',
    request
  ).catch((error) => error)
  let settled = false
  await vi.advanceTimersByTimeAsync(1_000)
  const queued = readMobileCurrentRequests(client, 'host-a', 'agentSession.currentRequests', {
    ...request,
    version: 'current'
  }).then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  try {
    await vi.advanceTimersByTimeAsync(14_000)
    expect(frames).toHaveLength(2)
    expect(tracker.size()).toBe(1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(true)
    expect(tracker.size()).toBe(0)
    await queued
    connection = 'disconnected'
    const connections = connect.mock.calls.length
    await expect(
      readMobileCurrentRequests(client, 'host-a', 'agentSession.currentRequests', request)
    ).rejects.toThrow('Not connected')
    expect(connect).toHaveBeenCalledTimes(connections)
    expect(tracker.size()).toBe(0)
    expect(frames).toHaveLength(2)
    connection = 'connected'
    const recovered = readMobileCurrentRequests(
      client,
      'host-a',
      'agentSession.currentRequests',
      request
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(frames).toHaveLength(3)
    tracker.resolve({ id: frames[2].id, ok: true, result: { json: '[]' } })
    await expect(recovered).resolves.toEqual({ json: '[]' })
    expect(tracker.size()).toBe(0)
  } finally {
    client.close()
    await Promise.all([old, queued])
    expect(tracker.size()).toBe(0)
  }
})
