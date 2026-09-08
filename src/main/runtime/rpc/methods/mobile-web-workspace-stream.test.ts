import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { isStreamingMethod } from '../core'
import { MOBILE_WEB_WORKSPACE_STREAM_METHODS } from './mobile-web-workspace-stream'

const [stream, unsubscribe] = MOBILE_WEB_WORKSPACE_STREAM_METHODS
if (!isStreamingMethod(stream) || isStreamingMethod(unsubscribe)) {
  throw new Error('Invalid methods')
}
const feed = stream
const stop = unsubscribe

function fixture() {
  const cleanups = new Map<string, () => void>()
  const listeners = new Set<(event: unknown) => void>()
  const runtime = {
    onClientEvent: vi.fn((callback: (event: unknown) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }),
    registerSubscriptionCleanup: vi.fn((key: string, cleanup: () => void) =>
      cleanups.set(key, cleanup)
    ),
    cleanupSubscription: vi.fn((key: string) => {
      const cleanup = cleanups.get(key)
      cleanups.delete(key)
      cleanup?.()
    })
  }
  const context = { runtime, connectionId: 'connection-1' } as unknown as RpcContext
  return { context, listeners, emit: (event: unknown) => listeners.forEach((l) => l(event)) }
}

describe('host workspace change feed', () => {
  it('reduces the client-event firehose to bare catalog change types', async () => {
    const f = fixture()
    const events: unknown[] = []
    const pending = feed.handler(null, f.context, (event) => events.push(event))
    await Promise.resolve()

    f.emit({ type: 'terminalOutput', worktreeId: '/private/repo::/private/tree', bytes: 'secret' })
    f.emit({ type: 'worktreesChanged', repoId: 'host-repo-secret' })
    f.emit({ type: 'reposChanged', repos: [{ path: '/private/repo' }] })

    expect(events).toEqual([
      expect.objectContaining({ type: 'ready' }),
      { type: 'worktreesChanged' },
      { type: 'reposChanged' }
    ])
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain('secret')

    const subscriptionId = (events[0] as { subscriptionId: string }).subscriptionId
    stop.handler({ subscriptionId }, f.context)
    await pending
    expect(events.at(-1)).toEqual({ type: 'end' })
    expect(f.listeners.size).toBe(0)
  })
  it('releases its listener when the socket aborts', async () => {
    const f = fixture()
    const abort = new AbortController()
    const events: unknown[] = []
    const pending = feed.handler(null, { ...f.context, signal: abort.signal }, (event) =>
      events.push(event)
    )
    expect(f.listeners.size).toBe(1)
    abort.abort()
    await pending
    expect(f.listeners.size).toBe(0)
    expect(events.at(-1)).toEqual({ type: 'end' })
  })

  it('does not register an already disconnected socket', async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    await feed.handler(null, { ...f.context, signal: abort.signal }, () => {})
    expect(f.listeners.size).toBe(0)
  })
})
