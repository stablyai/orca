import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { SESSION_TAB_METHODS } from './session-tabs'
import { listSessionTabsInventory } from './session-tabs-inventory'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tabs inventory RPC methods', () => {
  it('withholds an old-client list until the host inventory is authoritative', async () => {
    let resolveInventory!: (value: { snapshots: []; authoritative: true }) => void
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(
        () =>
          new Promise<{ snapshots: []; authoritative: true }>((resolve) => {
            resolveInventory = resolve
          })
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      { clientKind: 'runtime' }
    )
    for (let index = 0; index < 20 && !resolveInventory; index += 1) {
      await Promise.resolve()
    }
    expect(messages).toEqual([])

    resolveInventory({ snapshots: [], authoritative: true })
    await pending

    expect(JSON.parse(messages[0]!).result).toEqual({ snapshots: [] })
  })

  // Why: a census failure only invalidates the emptiness verdict — a hard error
  // here would blank the whole list for exactly the clients that negotiated the
  // capability (e.g. one configured-but-disconnected SSH host). The unlabeled
  // list keeps empty results behind the client probe, which stays unverifiable
  // for the same omitted-host condition.
  it('serves a capable client an unlabeled best-effort list when the census fails', async () => {
    const legacyListAll = vi.fn(async () => [
      {
        worktree: 'wt-local',
        publicationEpoch: 'epoch-local',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ])
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => {
        throw new Error('terminal_liveness_unavailable')
      }),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      {
        clientKind: 'runtime',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )

    expect(legacyListAll).toHaveBeenCalledTimes(1)
    const result = JSON.parse(messages[0]!).result
    expect(result.snapshots).toEqual([expect.objectContaining({ worktree: 'wt-local' })])
    expect(result.authoritative).toBeUndefined()
  })

  it('propagates disconnect errors to legacy clients instead of falling back', async () => {
    const legacyListAll = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => {
        throw new Error('client_disconnected')
      }),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      { clientKind: 'runtime' }
    )

    expect(legacyListAll).not.toHaveBeenCalled()
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'runtime_error' })
    })
  })

  it('labels an authoritative inventory only for a client that negotiated it', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => ({
        snapshots: [],
        authoritative: true as const
      }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      {
        clientKind: 'runtime',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )

    expect(JSON.parse(messages[0]!).result).toEqual({ snapshots: [], authoritative: true })
  })

  it('serves an old client a best-effort list when terminal liveness cannot be proven', async () => {
    const legacyListAll = vi.fn(async () => [
      {
        worktree: 'wt-local',
        publicationEpoch: 'epoch-local',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ])
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => {
        throw new Error('terminal_liveness_unavailable')
      }),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      { clientKind: 'runtime' }
    )

    expect(legacyListAll).toHaveBeenCalledTimes(1)
    expect(JSON.parse(messages[0]!).result).toEqual({
      snapshots: [expect.objectContaining({ worktree: 'wt-local' })]
    })
  })

  it('does not start the legacy fallback after the caller disconnects', async () => {
    const legacyListAll = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => {
        throw new Error('terminal_liveness_unavailable')
      }),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const controller = new AbortController()
    controller.abort()

    await expect(listSessionTabsInventory({ runtime, signal: controller.signal })).rejects.toThrow(
      'client_disconnected'
    )
    expect(legacyListAll).not.toHaveBeenCalled()
  })

  it('lets the final authoritative inventory subsume prior-epoch updates', async () => {
    let resolveInventory!: (value: {
      snapshots: RuntimeMobileSessionTabsResult[]
      authoritative: true
    }) => void
    const listeners: ((snapshot: RuntimeMobileSessionTabsResult) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(
        () =>
          new Promise<{
            snapshots: RuntimeMobileSessionTabsResult[]
            authoritative: true
          }>((resolve) => {
            resolveInventory = resolve
          })
      ),
      onMobileSessionTabsChanged: vi.fn(
        (listener: (snapshot: RuntimeMobileSessionTabsResult) => void) => {
          listeners.push(listener)
          return vi.fn()
        }
      ),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      {
        connectionId: 'conn-authoritative',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )
    await Promise.resolve()
    listeners[0]?.({
      worktree: 'wt-authoritative',
      publicationEpoch: 'epoch-before-reload',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    expect(messages).toEqual([])

    resolveInventory({
      snapshots: [
        {
          worktree: 'wt-authoritative',
          publicationEpoch: 'epoch-after-reload',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ],
      authoritative: true
    })
    await pending
    listeners[0]?.({
      worktree: 'wt-authoritative',
      publicationEpoch: 'epoch-after-reload',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })

    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      {
        type: 'snapshots',
        snapshots: [
          expect.objectContaining({
            worktree: 'wt-authoritative',
            publicationEpoch: 'epoch-after-reload',
            snapshotVersion: 1
          })
        ],
        authoritative: true
      },
      expect.objectContaining({
        type: 'updated',
        worktree: 'wt-authoritative',
        publicationEpoch: 'epoch-after-reload',
        snapshotVersion: 2
      })
    ])
  })

  it('lets authoritative empty inventory win over prior-epoch updates', async () => {
    let resolveInventory!: (value: { snapshots: []; authoritative: true }) => void
    const listeners: ((snapshot: RuntimeMobileSessionTabsResult) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(
        () =>
          new Promise<{ snapshots: []; authoritative: true }>((resolve) => {
            resolveInventory = resolve
          })
      ),
      onMobileSessionTabsChanged: vi.fn(
        (listener: (snapshot: RuntimeMobileSessionTabsResult) => void) => {
          listeners.push(listener)
          return vi.fn()
        }
      ),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    const snapshot = (snapshotVersion: number): RuntimeMobileSessionTabsResult => ({
      worktree: 'wt-buffered',
      publicationEpoch: 'epoch-buffered',
      snapshotVersion,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })

    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      {
        connectionId: 'conn-authoritative-empty',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )
    await Promise.resolve()
    listeners[0]?.(snapshot(2))
    listeners[0]?.(snapshot(3))

    resolveInventory({ snapshots: [], authoritative: true })
    await pending

    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true }
    ])
  })

  it('does no subscription work for an already-cancelled stream', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(),
      onMobileSessionTabsChanged: vi.fn(),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const controller = new AbortController()
    const messages: string[] = []
    controller.abort()

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { signal: controller.signal }
    )

    expect(runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
    expect(runtime.listAllMobileSessionTabsInventory).not.toHaveBeenCalled()
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'runtime_error' })
      })
    ])
  })

  it('aborts and removes a publication waiter when the stream is cleaned up', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      {
        connectionId: 'conn-cancel',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )
    const waiters = (runtime as unknown as { sessionTabsInventoryWaiters: Set<() => void> })
      .sessionTabsInventoryWaiters
    for (let index = 0; index < 20 && waiters.size === 0; index += 1) {
      await Promise.resolve()
    }
    expect(waiters.size).toBe(1)

    runtime.cleanupSubscription('session.tabs:conn-cancel:*:req-1')
    await pending

    expect(waiters.size).toBe(0)
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'runtime_error' })
      })
    ])
  })
})
