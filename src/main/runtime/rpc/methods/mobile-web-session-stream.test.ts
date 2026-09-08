import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_SESSION_STREAM_METHODS } from './mobile-web-session-stream'
import { sessionFixture } from './mobile-web-session-test-fixture'
import { isStreamingMethod } from '../core'

const [stream, unsubscribe] = MOBILE_WEB_SESSION_STREAM_METHODS
if (!isStreamingMethod(stream) || isStreamingMethod(unsubscribe)) {
  throw new Error('Invalid methods')
}
const feed = stream
const stop = unsubscribe

describe('host session feed lifecycle', () => {
  it('scopes live updates to the workspace and emits bounded snapshots', async () => {
    const f = sessionFixture()
    const events: unknown[] = []
    await feed.handler(f.params, f.context, (event) => events.push(event))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'ready' })
    expect(events[1]).toMatchObject({
      type: 'snapshot',
      snapshot: { workspaceId: f.params.workspaceId, snapshotVersion: 1 }
    })
    f.setSnapshot({ ...f.snapshot, worktree: 'different', snapshotVersion: 2 })
    f.emit()
    expect(events).toHaveLength(2)
    f.setSnapshot({ ...f.snapshot, worktree: 'folder:workspace', snapshotVersion: 3 })
    f.emit()
    expect(events).toHaveLength(3)
    expect(JSON.stringify(events)).not.toContain('private')
    const id = (events[0] as { subscriptionId: string }).subscriptionId
    stop.handler({ subscriptionId: id }, f.context)
    expect(f.listeners.size).toBe(0)
    expect(events.at(-1)).toEqual({ type: 'end' })
  })

  it('delivers large multibyte tab inventories inside the event budget', async () => {
    const f = sessionFixture()
    f.setSnapshot({
      ...f.snapshot,
      activeTabType: 'browser',
      tabs: Array.from({ length: 100 }, (_, index) => ({
        type: 'browser',
        id: `browser-${index}`,
        browserPageId: `private-${index}`,
        title: '界'.repeat(240),
        url: `https://example.com/${'界'.repeat(1200)}`,
        isActive: index === 90
      }))
    })
    const events: unknown[] = []
    await feed.handler(f.params, f.context, (event) => events.push(event))
    expect(events[1]).toMatchObject({ type: 'snapshot', snapshot: { truncated: true } })
    expect(Buffer.byteLength(JSON.stringify(events[1]))).toBeLessThan(128 * 1024 + 100)
    expect(f.listeners.size).toBe(1)
    f.controller.abort()
  })

  it('cleans up unsubscribe while initial snapshot is still pending', async () => {
    const f = sessionFixture()
    let release!: () => void
    f.runtime.listMobileSessionTabs.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return f.snapshot
    })
    const events: unknown[] = []
    const pending = feed.handler(f.params, f.context, (event) => events.push(event))
    await vi.waitFor(() => expect(release).toBeDefined())
    stop.handler(
      { subscriptionId: (events[0] as { subscriptionId: string }).subscriptionId },
      f.context
    )
    release()
    await pending
    expect(events.map((event) => (event as { type: string }).type)).toEqual(['ready', 'end'])
    expect(f.listeners.size).toBe(0)
    expect(f.cleanups.size).toBe(0)
  })

  // A path selector never spells the canonical worktree the inner feed keys its cleanup by.
  it('removes an inner session listener opened under a path selector', async () => {
    const f = sessionFixture()
    let release!: () => void
    f.runtime.listMobileSessionTabs.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return f.snapshot
    })
    const events: unknown[] = []
    const params = { ...f.params, worktree: '/repos/workspace' }
    const pending = feed.handler(params, f.context, (event) => events.push(event))
    await vi.waitFor(() => expect(release).toBeDefined())
    stop.handler(
      { subscriptionId: (events[0] as { subscriptionId: string }).subscriptionId },
      f.context
    )
    release()
    await pending
    expect(f.listeners.size).toBe(0)
    expect(f.cleanups.size).toBe(0)
  })

  it('closes on dropped client and reconnect creates a separate feed', async () => {
    const f = sessionFixture()
    const first: unknown[] = []
    await feed.handler(f.params, f.context, (event) => first.push(event))
    f.controller.abort()
    expect(f.listeners.size).toBe(0)
    const events: unknown[] = []
    const context = {
      ...f.context,
      connectionId: 'reconnected',
      signal: new AbortController().signal
    }
    await feed.handler(f.params, context, (event) => events.push(event))
    expect(f.listeners.size).toBe(1)
    stop.handler(
      { subscriptionId: (first[0] as { subscriptionId: string }).subscriptionId },
      context
    )
    expect(f.listeners.size).toBe(1)
    stop.handler(
      { subscriptionId: (events[0] as { subscriptionId: string }).subscriptionId },
      context
    )
    expect(f.listeners.size).toBe(0)
  })
})
