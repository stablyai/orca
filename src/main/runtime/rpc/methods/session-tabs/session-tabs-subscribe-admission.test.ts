import { EVERY_AGENT_CHAT } from '../../../../../shared/native-chat/every-agent-chat.test-fixture'

import '../../callers/runtime-client-capabilities'
import type { RuntimeClientCapabilities } from '../../callers/runtime-client-capabilities'

import { describe, expect, it, vi } from 'vitest'

import type { OrcaRuntimeService } from '../../../orca-runtime'

import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'

import { RuntimeSubscriptionRegistry } from '../../../client/runtime-subscription-registry'

import { RpcDispatcher } from '../../dispatcher'

import type { RpcRequest } from '../../core'

import { SESSION_TAB_METHODS } from './session-tabs'

import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

const CONNECTION = 'conn-1'
const KEY = (requestId: string): string => `session.tabs:${CONNECTION}:wt-1:${requestId}`

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
      nativeChatProviders: options.structuredChat === true ? EVERY_AGENT_CHAT : {}
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
      extra: { signal?: AbortSignal; capabilitySource?: RuntimeClientCapabilities } = {}
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

  it('a request abort during setup ends the stream and leaves nothing', async () => {
    const host = makeHost()
    const listing = deferred<RuntimeMobileSessionTabsResult>()
    host.listMobileSessionTabs.mockReturnValueOnce(listing.promise)
    const controller = new AbortController()
    const messages: Frame[] = []
    const pending = host.dispatch(
      request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }),
      messages,
      { signal: controller.signal }
    )

    controller.abort()
    listing.resolve(visibleSnapshot())
    await pending
    await settle()

    expect(host.isRegistered(KEY('sub-1'))).toBe(false)
    expect(host.runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
    expect(frames(messages)).toEqual(['end'])
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

  it('a worktree-wide unsubscribe spares a subscribe that arrives while it resolves', async () => {
    const host = makeHost()
    const first: Frame[] = []
    const second: Frame[] = []
    await host.dispatch(request('sub-1', 'session.tabs.subscribe', { worktree: 'id:wt-1' }), first)
    const listing = deferred<RuntimeMobileSessionTabsResult>()
    host.listMobileSessionTabs.mockReturnValueOnce(listing.promise)

    // Non-id selectors still await resolution; newer streams must survive that delay.
    const unsubscribing = host.dispatch(
      request('unsub-1', 'session.tabs.unsubscribe', { worktree: 'name:workspace' })
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
})
