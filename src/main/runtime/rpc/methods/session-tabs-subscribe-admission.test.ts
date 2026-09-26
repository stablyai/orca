import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

const CONNECTION = 'conn-1'
const KEY = (requestId: string): string => `session.tabs:${CONNECTION}:wt-1:${requestId}`
const ALL_KEY = (requestId: string): string => `session.tabs:${CONNECTION}:*:${requestId}`

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (e: Error) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function makeHost(options: { structuredChat?: boolean } = {}) {
  const registry = new RuntimeSubscriptionRegistry()
  const stopListening = vi.fn()
  const tabListeners: ((snapshot: RuntimeMobileSessionTabsResult, sequence: number) => void)[] = []
  const restore = vi.fn(() => Promise.resolve())
  const listMobileSessionTabs = vi.fn(async (): Promise<RuntimeMobileSessionTabsResult> =>
    visibleSnapshot()
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session tab methods reach only these members; a missing one throws and fails the test.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => ({
      experimentalStructuredNativeChat: options.structuredChat === true
    }),
    restoreStructuredAgentSessionTabs: restore,
    listMobileSessionTabs,
    supportsAuthoritativeSessionTabsInventory: () => false,
    listAllMobileSessionTabsWithChangeSequence: async () => ({
      snapshots: [visibleSnapshot()],
      changeSequence: 0
    }),
    onMobileSessionTabsChanged: vi.fn(
      (listener: (snapshot: RuntimeMobileSessionTabsResult, sequence: number) => void) => {
        tabListeners.push(listener)
        return stopListening
      }
    ),
    registerSubscriptionCleanup: registry.register.bind(registry),
    cleanupSubscription: registry.cleanup.bind(registry),
    cleanupSubscriptionsByPrefix: registry.cleanupByPrefix.bind(registry),
    cleanupSubscriptionsForConnection: registry.cleanupForConnection.bind(registry),
    getSubscriptionRegistrationVersion: registry.getRegistrationVersion.bind(registry)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  return {
    runtime,
    registry,
    restore,
    listMobileSessionTabs,
    stopListening,
    tabListeners,
    // A foreign connection never owns the entry, so this probe reads presence without releasing it.
    isRegistered: (id: string): boolean => !registry.cleanupIfOwnedByConnection(id, 'probe'),
    dispatch: (
      request: RpcRequest,
      messages: Frame[] = [],
      extra: { signal?: AbortSignal } = {}
    ): Promise<void> =>
      dispatcher.dispatchStreaming(request, (message) => messages.push(JSON.parse(message)), {
        connectionId: CONNECTION,
        clientKind: 'mobile',
        ...extra
      })
  }
}

function request(id: string, method: string, params?: unknown): RpcRequest {
  return { id, authToken: 'tok', method, params }
}

type Frame = { ok: boolean; result?: { type?: string } }

function frames(messages: Frame[]): (string | undefined)[] {
  return messages.map((reply) => (reply.ok ? reply.result?.type : 'error'))
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('session.tabs.subscribe registers when the request arrives', () => {
  it.each([
    { stage: 'restore', unsubscribe: { worktree: 'id:wt-1', subscriptionId: 'sub-1' } },
    { stage: 'list', unsubscribe: { worktree: 'id:wt-1', subscriptionId: 'sub-1' } },
    { stage: 'list', unsubscribe: { worktree: 'id:wt-1' } }
  ])(
    'an unsubscribe ($unsubscribe) during the $stage await ends the stream and leaves nothing',
    async ({ stage, unsubscribe }) => {
      const host = makeHost({ structuredChat: true })
      const gate = deferred<void>()
      const listing = deferred<RuntimeMobileSessionTabsResult>()
      if (stage === 'restore') {
        host.restore.mockReturnValueOnce(gate.promise)
      } else {
        host.listMobileSessionTabs.mockReturnValueOnce(listing.promise)
      }
      const messages: Frame[] = []
      const pending = host.dispatch(
        request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }),
        messages
      )

      await host.dispatch(request('unsub-1', 'session.tabs.unsubscribe', unsubscribe))
      gate.resolve()
      listing.resolve(visibleSnapshot())
      await pending
      await settle()

      expect(host.isRegistered(KEY('sub-1'))).toBe(false)
      expect(host.runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
      expect(frames(messages)).toEqual(['end'])
    }
  )

  it('a socket close during setup leaves no registration and no listener', async () => {
    const host = makeHost()
    const listing = deferred<RuntimeMobileSessionTabsResult>()
    host.listMobileSessionTabs.mockReturnValueOnce(listing.promise)
    const messages: Frame[] = []
    const pending = host.dispatch(
      request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }),
      messages
    )

    host.runtime.cleanupSubscriptionsForConnection(CONNECTION)
    listing.resolve(visibleSnapshot())
    await pending
    await settle()

    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
    expect(host.runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
    expect(frames(messages)).toEqual(['end'])
  })

  it('a request whose socket already closed attaches nothing', async () => {
    const host = makeHost()
    const controller = new AbortController()
    controller.abort()

    await host.dispatch(request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }), [], {
      signal: controller.signal
    })
    await settle()

    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
    expect(host.runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
  })

  it('a stream released during setup reports no error when the await then rejects', async () => {
    const host = makeHost()
    const listing = deferred<RuntimeMobileSessionTabsResult>()
    host.listMobileSessionTabs.mockReturnValueOnce(listing.promise)
    const messages: Frame[] = []
    const pending = host.dispatch(
      request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }),
      messages
    )

    await host.dispatch(
      request('unsub-1', 'session.tabs.unsubscribe', {
        worktree: 'id:wt-1',
        subscriptionId: 'sub-1'
      })
    )
    listing.reject(new Error('list failed'))
    await pending

    expect(frames(messages)).toEqual(['end'])
  })

  it('a failed setup reports only the error and leaves no registration', async () => {
    const host = makeHost()
    host.listMobileSessionTabs.mockRejectedValueOnce(new Error('list failed'))
    const messages: Frame[] = []

    await host.dispatch(
      request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }),
      messages
    )
    await settle()

    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
    expect(frames(messages)).toEqual(['error'])
  })

  it('streams snapshot and updates, then ends once on unsubscribe', async () => {
    const host = makeHost()
    const messages: Frame[] = []

    await host.dispatch(
      request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }),
      messages
    )
    expect(host.isRegistered(KEY('sub-1'))).toBe(true)
    host.tabListeners[0]?.({ ...visibleSnapshot(), snapshotVersion: 2 }, 1)
    await host.dispatch(
      request('unsub-1', 'session.tabs.unsubscribe', {
        worktree: 'id:wt-1',
        subscriptionId: 'sub-1'
      })
    )
    host.runtime.cleanupSubscriptionsForConnection(CONNECTION)
    await settle()

    expect(frames(messages)).toEqual(['snapshot', 'updated', 'end'])
    expect(host.stopListening).toHaveBeenCalledTimes(1)
    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
  })

  it('keys a non-id selector by the resolved worktree once it is known', async () => {
    const host = makeHost()
    const messages: Frame[] = []

    await host.dispatch(
      request('sub-1', 'session.tabs.subscribe', { worktree: 'path:/repo/wt-1' }),
      messages
    )

    expect(host.isRegistered(KEY('sub-1'))).toBe(true)
    expect(frames(messages)).toEqual(['snapshot'])
  })

  it('a worktree-wide unsubscribe spares a subscribe that arrives while it resolves', async () => {
    const host = makeHost()
    const first: Frame[] = []
    const second: Frame[] = []
    await host.dispatch(request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }), first)
    const listing = deferred<RuntimeMobileSessionTabsResult>()
    host.listMobileSessionTabs.mockReturnValueOnce(listing.promise)

    // Old phones send no request id, so the host sweeps every stream for the worktree.
    const unsubscribing = host.dispatch(
      request('unsub-1', 'session.tabs.unsubscribe', { worktree: 'id:wt-1' })
    )
    await settle()
    await host.dispatch(request('sub-2', 'session.tabs.subscribe', { worktree: 'id:wt-1' }), second)
    listing.resolve(visibleSnapshot())
    await unsubscribing
    await settle()

    expect(frames(first)).toEqual(['snapshot', 'end'])
    expect(frames(second)).toEqual(['snapshot'])
    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
    expect(host.isRegistered(KEY('sub-2'))).toBe(true)
  })

  it('a request-id unsubscribe ends only its own stream', async () => {
    const host = makeHost()
    const first: Frame[] = []
    const second: Frame[] = []

    await host.dispatch(request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }), first)
    await host.dispatch(request('sub-2', 'session.tabs.subscribe', { worktree: 'id:wt-1' }), second)
    await host.dispatch(
      request('unsub-1', 'session.tabs.unsubscribe', {
        worktree: 'id:wt-1',
        subscriptionId: 'sub-1'
      })
    )
    await settle()

    expect(frames(first)).toEqual(['snapshot', 'end'])
    expect(frames(second)).toEqual(['snapshot'])
    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
    expect(host.isRegistered(KEY('sub-2'))).toBe(true)
    expect(host.stopListening).toHaveBeenCalledTimes(1)
  })
})

describe('session.tabs.subscribeAll registers before restoring structured tabs', () => {
  it.each([
    {
      release: 'unsubscribeAll',
      act: (host: ReturnType<typeof makeHost>) =>
        host.dispatch(
          request('unsub-1', 'session.tabs.unsubscribeAll', { subscriptionId: 'sub-1' })
        )
    },
    {
      release: 'socket close',
      act: async (host: ReturnType<typeof makeHost>) =>
        host.runtime.cleanupSubscriptionsForConnection(CONNECTION)
    }
  ])('a $release during the restore leaves no stream behind', async ({ act }) => {
    const host = makeHost({ structuredChat: true })
    const gate = deferred<void>()
    host.restore.mockReturnValueOnce(gate.promise)
    const messages: Frame[] = []
    const pending = host.dispatch(request('sub-1', 'session.tabs.subscribeAll'), messages)

    await act(host)
    gate.resolve()
    await pending
    await settle()

    expect(host.isRegistered(ALL_KEY('sub-1'))).toBe(false)
    expect(frames(messages)).not.toContain('snapshots')
    expect(
      vi.mocked(host.runtime.onMobileSessionTabsChanged).mock.calls.length -
        host.stopListening.mock.calls.length
    ).toBe(0)
  })
})
