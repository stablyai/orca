import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebSourceControlSubscriptions } from './mobile-web-source-control-subscriptions'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture()

describe('MobileWebSourceControlSubscriptions', () => {
  it('publishes bounded invalidations without forwarding host paths', async () => {
    const harness = createHarness()
    harness.subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      pageWorkspaceId: 'workspace-1',
      hostWorkspaceId: 'workspace-1',
      client: harness.client
    })

    expect(harness.subscribe).toHaveBeenCalledWith(
      'files.watch',
      { worktree: 'id:workspace-1' },
      expect.any(Function)
    )
    harness.listener?.({
      type: 'changed',
      worktree: 'id:workspace-1',
      events: [
        { kind: 'update', absolutePath: '/private/repo/secret.ts' },
        { kind: 'overflow', absolutePath: '/private/repo' }
      ]
    })
    await vi.waitFor(() => expect(harness.events).toHaveLength(1))

    expect(harness.events[0]).toEqual({
      subscriptionId: 'subscription-1',
      sequence: 0,
      event: { workspaceId: 'workspace-1', reason: 'overflow' }
    })
    expect(JSON.stringify(harness.events)).not.toContain('/private/repo')
  })

  it('orders changed events and suppresses delivery after cancellation', async () => {
    const harness = createHarness()
    harness.subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      pageWorkspaceId: 'workspace-1',
      hostWorkspaceId: 'workspace-1',
      client: harness.client
    })
    const changed = {
      type: 'changed',
      worktree: 'id:workspace-1',
      events: [{ kind: 'update', absolutePath: '/repo/a.ts' }]
    }
    harness.listener?.(changed)
    harness.listener?.(changed)
    await vi.waitFor(() => expect(harness.events).toHaveLength(2))

    expect(harness.events.map((value) => value.sequence)).toEqual([0, 1])
    expect(harness.subscriptions.cancel('subscription-1')).toBe('request-1')
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    harness.listener?.(changed)
    await Promise.resolve()
    expect(harness.events).toHaveLength(2)
  })

  it('reports watcher termination once, then retires the host subscription', async () => {
    const harness = createHarness()
    harness.subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      pageWorkspaceId: 'workspace-1',
      hostWorkspaceId: 'workspace-1',
      client: harness.client
    })

    harness.listener?.({ type: 'error', message: 'watch failed', rootPath: '/private/repo' })
    harness.listener?.({ type: 'end' })
    await vi.waitFor(() => expect(harness.unsubscribe).toHaveBeenCalledOnce())

    expect(harness.events).toEqual([
      {
        subscriptionId: 'subscription-1',
        sequence: 0,
        event: { workspaceId: 'workspace-1', reason: 'unavailable' }
      }
    ])
    expect(JSON.stringify(harness.events)).not.toContain('watch failed')
  })

  it('tears down a synchronous invalid first event exactly once', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_method, _params, listener) => {
      listener({ type: 'changed', worktree: 'id:other', events: [] })
      return unsubscribe
    })
    const subscriptions = new MobileWebSourceControlSubscriptions({
      isActive: () => true,
      workspaceAuthority,
      postEvent: vi.fn(),
      postClosed: vi.fn()
    })

    subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      pageWorkspaceId: 'workspace-1',
      hostWorkspaceId: 'workspace-1',
      client: { subscribe } as unknown as RpcClient
    })

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscriptions.cancel('subscription-1')).toBeNull()
  })

  it('retires a watcher before delivery when its opaque workspace binding is revoked', () => {
    const authority = new MobileWebWorkspaceAuthority(() => new Uint8Array(16).fill(13))
    authority.synchronize([{ workspaceId: 'host-workspace', repoId: 'host-repo' }])
    const pageWorkspaceId = authority.pageWorkspaceId('host-workspace')
    const harness = createHarness(authority)
    harness.subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      pageWorkspaceId,
      hostWorkspaceId: 'host-workspace',
      client: harness.client
    })
    authority.synchronize([])

    harness.listener?.({
      type: 'changed',
      worktree: 'id:host-workspace',
      events: [{ kind: 'update', absolutePath: '/private/repo/a.ts' }]
    })

    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.events).toEqual([])
    // Without this frame the page keeps a live entry and freezes on its last status forever.
    expect(harness.closures).toEqual([{ code: 'not_found', retryable: false }])
  })

  it('does not close the page subscription on the normal end-of-watch retirement', async () => {
    const harness = createHarness()
    harness.subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      pageWorkspaceId: 'workspace-1',
      hostWorkspaceId: 'workspace-1',
      client: harness.client
    })

    harness.listener?.({ type: 'end' })
    await vi.waitFor(() => expect(harness.unsubscribe).toHaveBeenCalledOnce())

    expect(harness.closures).toEqual([])
  })
})

function createHarness(authority = workspaceAuthority) {
  let listener: ((event: unknown) => void) | undefined
  const unsubscribe = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, nextListener) => {
    listener = nextListener
    return unsubscribe
  })
  const events: { subscriptionId: string; sequence: number; event: unknown }[] = []
  const closures: { code: string; retryable: boolean }[] = []
  const subscriptions = new MobileWebSourceControlSubscriptions({
    isActive: () => true,
    workspaceAuthority: authority,
    postEvent: async (subscriptionId, sequence, event) => {
      events.push({ subscriptionId, sequence, event })
    },
    postClosed: (_subscriptionId, closure) => {
      closures.push(closure)
    }
  })
  return {
    subscriptions,
    client: { subscribe } as unknown as RpcClient,
    subscribe,
    unsubscribe,
    events,
    closures,
    get listener() {
      return listener
    }
  }
}
