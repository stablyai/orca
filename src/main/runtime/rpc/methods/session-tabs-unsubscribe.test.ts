import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

describe('session tab unsubscribe RPC methods', () => {
  it('releases an explicit workspace stream even when its inventory cannot resolve', async () => {
    const cleanupSubscription = vi.fn()
    const runtime = runtimeWithCleanup(cleanupSubscription)
    const list = vi
      .spyOn(runtime, 'listMobileSessionTabs')
      .mockRejectedValue(new Error('selector_ambiguous'))
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      request('session.tabs.unsubscribe', {
        worktree: 'id:repo::G:\\git\\example',
        subscriptionId: 'sub-1'
      }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith(
      'session.tabs:conn-1:repo::g:/git/example:sub-1'
    )
    expect(list).not.toHaveBeenCalled()
  })

  it('uses the resolved worktree id and connection id', async () => {
    const cleanupSubscription = vi.fn()
    const runtime = runtimeWithCleanup(cleanupSubscription)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      request('session.tabs.unsubscribe', { worktree: 'id:wt-1' }),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1')
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: true,
      result: { unsubscribed: true }
    })
  })

  it('unsubscribes one shared-control worktree stream by subscription id', async () => {
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionsByPrefix = vi.fn()
    const runtime = runtimeWithCleanup(cleanupSubscription, cleanupSubscriptionsByPrefix)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      request('session.tabs.unsubscribe', {
        worktree: 'id:wt-1',
        subscriptionId: 'sub-1'
      }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1:sub-1')
    expect(cleanupSubscriptionsByPrefix).not.toHaveBeenCalled()
  })

  it('unsubscribes one shared-control all-tabs stream by subscription id', async () => {
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionsByPrefix = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscription,
      cleanupSubscriptionsByPrefix
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      request('session.tabs.unsubscribeAll', { subscriptionId: 'sub-all-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:*:sub-all-1')
    expect(cleanupSubscriptionsByPrefix).not.toHaveBeenCalled()
  })

  it('ends only the named stream when a newer one watches the same worktree', async () => {
    const { dispatcher, ends } = await subscribeTwiceToOneWorktree()

    await dispatcher.dispatchStreaming(
      request('session.tabs.unsubscribe', { worktree: 'id:wt-1', subscriptionId: 'sub-old' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    await vi.waitFor(() => expect(ends['sub-old']).toBe(1))
    expect(ends['sub-new']).toBe(0)
  })

  it('ends every stream for the worktree when the unsubscribe names no request', async () => {
    const { dispatcher, ends } = await subscribeTwiceToOneWorktree()

    await dispatcher.dispatchStreaming(
      request('session.tabs.unsubscribe', { worktree: 'id:wt-1' }),
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    await vi.waitFor(() => expect(ends).toEqual({ 'sub-old': 1, 'sub-new': 1 }))
  })

  it.each([
    { subscriptionId: undefined, useCanonicalId: false },
    { subscriptionId: 'sub-old', useCanonicalId: false },
    { subscriptionId: undefined, useCanonicalId: true },
    { subscriptionId: 'sub-old', useCanonicalId: true }
  ])(
    'unsubscribes a path alias after the initial snapshot resolves its spelling (%j)',
    async ({ subscriptionId, useCanonicalId }) => {
      const selector = 'id:repo::G:/git/example'
      const { dispatcher, ends } = await subscribeTwiceToOneWorktree(
        selector,
        'repo::G:\\git\\example'
      )

      await dispatcher.dispatchStreaming(
        request('session.tabs.unsubscribe', {
          worktree: useCanonicalId ? 'id:repo::G:\\git\\example' : selector,
          subscriptionId
        }),
        vi.fn(),
        { connectionId: 'conn-1' }
      )

      expect(ends).toEqual({ 'sub-old': 1, 'sub-new': subscriptionId ? 0 : 1 })
    }
  )
})

/** Separates the requested spelling from the host's reply to expose stream cleanup mismatches. */
async function subscribeTwiceToOneWorktree(selector = 'id:wt-1', resolvedWorktree = 'wt-1') {
  const registry = new RuntimeSubscriptionRegistry()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Partial runtime backed by the real subscription registry; it supplies every member session.tabs subscribe/unsubscribe call.
  const runtime = {
    ...runtimeWithCleanup(registry.cleanup.bind(registry), registry.cleanupByPrefix.bind(registry)),
    listMobileSessionTabs: async () => ({
      worktree: resolvedWorktree,
      publicationEpoch: 'test',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }),
    registerSubscriptionCleanup: registry.register.bind(registry),
    getSubscriptionRegistrationVersion: registry.getRegistrationVersion.bind(registry),
    onMobileSessionTabsChanged: () => () => {}
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const ends: Record<string, number> = { 'sub-old': 0, 'sub-new': 0 }
  for (const id of ['sub-old', 'sub-new']) {
    await dispatcher.dispatchStreaming(
      { ...request('session.tabs.subscribe', { worktree: selector }), id },
      (message) => {
        if (JSON.parse(message).result?.type === 'end') {
          ends[id]! += 1
        }
      },
      { connectionId: 'conn-1' }
    )
  }
  return { dispatcher, ends }
}

function runtimeWithCleanup(
  cleanupSubscription: (id: string) => void,
  cleanupSubscriptionsByPrefix: (prefix: string, throughVersion?: number) => void = vi.fn()
): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the unsubscribe methods reach only these members; a missing one throws and fails the test.
  return {
    getRuntimeId: () => 'test-runtime',
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      publicationEpoch: 'test',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }),
    cleanupSubscription,
    cleanupSubscriptionsByPrefix,
    getSubscriptionRegistrationVersion: () => 0
  } as unknown as OrcaRuntimeService
}

function request(method: string, params: unknown) {
  return { id: 'request-a', authToken: 'token-a', method, params }
}
