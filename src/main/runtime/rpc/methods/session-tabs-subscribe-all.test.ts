import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(
  worktree: string,
  snapshotVersion: number,
  publicationEpoch = 'epoch-1'
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

describe('session.tabs.subscribeAll startup', () => {
  it('coalesces post-capture changes until the initial inventory is emitted', async () => {
    const unsubscribe = vi.fn()
    const subscription = deferred<{
      snapshots: RuntimeMobileSessionTabsResult[]
      unsubscribe: () => void
    }>()
    let listener: ((next: RuntimeMobileSessionTabsResult) => void) | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      subscribeAllMobileSessionTabs: vi.fn(
        (next: (snapshot: RuntimeMobileSessionTabsResult) => void) => {
          listener = next
          return subscription.promise
        }
      ),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    const request: RpcRequest = {
      id: 'subscribe-all-1',
      authToken: 'token',
      method: 'session.tabs.subscribeAll'
    }

    const pending = dispatcher.dispatchStreaming(request, (message) => messages.push(message), {
      connectionId: 'connection-1'
    })

    await vi.waitFor(() => expect(listener).toBeDefined())
    listener?.(snapshot('worktree-1', 1, 'epoch-2'))
    listener?.(snapshot('worktree-1', 2, 'epoch-2'))
    listener?.(snapshot('worktree-2', 2))
    subscription.resolve({
      snapshots: [snapshot('worktree-1', 5), snapshot('worktree-2', 1)],
      unsubscribe
    })
    await pending

    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      {
        type: 'snapshots',
        snapshots: [snapshot('worktree-1', 5), snapshot('worktree-2', 1)]
      },
      { type: 'updated', ...snapshot('worktree-1', 2, 'epoch-2') },
      { type: 'updated', ...snapshot('worktree-2', 2) }
    ])
  })

  it('unsubscribes an atomic listener that resolves after cleanup', async () => {
    const subscription = deferred<{
      snapshots: RuntimeMobileSessionTabsResult[]
      unsubscribe: () => void
    }>()
    const unsubscribe = vi.fn()
    let cleanup: (() => void) | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      subscribeAllMobileSessionTabs: vi.fn(() => subscription.promise),
      registerSubscriptionCleanup: vi.fn((_id: string, next: () => void) => {
        cleanup = next
      }),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const emit = vi.fn()
    const pending = dispatcher.dispatchStreaming(
      {
        id: 'subscribe-all-close',
        authToken: 'token',
        method: 'session.tabs.subscribeAll'
      },
      emit,
      { connectionId: 'connection-1' }
    )

    await vi.waitFor(() => expect(cleanup).toBeDefined())
    cleanup?.()
    subscription.resolve({ snapshots: [snapshot('worktree-1', 1)], unsubscribe })
    await pending

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(emit).not.toHaveBeenCalled()
  })

  it('cleans up the listener when initial projection fails', async () => {
    const unsubscribe = vi.fn()
    let cleanup: (() => void) | undefined
    const brokenSnapshot = {
      ...snapshot('worktree-1', 1),
      get tabs(): RuntimeMobileSessionTabsResult['tabs'] {
        throw new Error('projection failed')
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      subscribeAllMobileSessionTabs: vi.fn(async () => ({
        snapshots: [brokenSnapshot],
        unsubscribe
      })),
      registerSubscriptionCleanup: vi.fn((_id: string, next: () => void) => {
        cleanup = next
      }),
      cleanupSubscription: vi.fn(() => cleanup?.())
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      {
        id: 'subscribe-all-projection-error',
        authToken: 'token',
        method: 'session.tabs.subscribeAll'
      },
      (message) => messages.push(message),
      { connectionId: 'connection-1', clientKind: 'runtime', clientCapabilities: [] }
    )

    expect(runtime.cleanupSubscription).toHaveBeenCalledWith(
      'session.tabs:connection-1:*:subscribe-all-projection-error'
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(messages.map((message) => JSON.parse(message).ok)).toEqual([false])
  })
})

describe('atomic all-session inventory boundary', () => {
  type InventoryBoundary = {
    refreshAllMobileSessionTabs: () => Promise<void>
    captureAllMobileSessionTabs: (clientNavigationId?: string) => RuntimeMobileSessionTabsResult[]
  }

  it('installs the listener after refresh and before capture', async () => {
    const runtime = new OrcaRuntimeService()
    const boundary = runtime as unknown as InventoryBoundary
    const refreshed = deferred<void>()
    const order: string[] = []
    const unsubscribe = vi.fn()
    const listener = vi.fn()
    boundary.refreshAllMobileSessionTabs = vi.fn(async () => {
      order.push('refresh:start')
      await refreshed.promise
      order.push('refresh:end')
    })
    const listen = vi
      .spyOn(runtime, 'onMobileSessionTabsChanged')
      .mockImplementation((_listener, clientNavigationId) => {
        order.push(`listen:${clientNavigationId}`)
        return unsubscribe
      })
    boundary.captureAllMobileSessionTabs = vi.fn((clientNavigationId) => {
      order.push(`capture:${clientNavigationId}`)
      return []
    })

    const pending = runtime.subscribeAllMobileSessionTabs(listener, 'client-1')
    expect(order).toEqual(['refresh:start'])
    refreshed.resolve()

    await expect(pending).resolves.toEqual({ snapshots: [], unsubscribe })
    expect(order).toEqual(['refresh:start', 'refresh:end', 'listen:client-1', 'capture:client-1'])
    expect(listen).toHaveBeenCalledWith(listener, 'client-1')
  })

  it('removes the listener when synchronous capture fails', async () => {
    const runtime = new OrcaRuntimeService()
    const boundary = runtime as unknown as InventoryBoundary
    const unsubscribe = vi.fn()
    boundary.refreshAllMobileSessionTabs = vi.fn(async () => {})
    vi.spyOn(runtime, 'onMobileSessionTabsChanged').mockReturnValue(unsubscribe)
    boundary.captureAllMobileSessionTabs = vi.fn(() => {
      throw new Error('capture failed')
    })

    await expect(runtime.subscribeAllMobileSessionTabs(vi.fn())).rejects.toThrow('capture failed')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
