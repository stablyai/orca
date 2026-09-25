import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

describe('session tab unsubscribe RPC methods', () => {
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
})

async function subscribeTwiceToOneWorktree() {
  const registry = new RuntimeSubscriptionRegistry()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Partial runtime backed by the real subscription registry; it supplies every member session.tabs subscribe/unsubscribe call.
  const runtime = {
    ...runtimeWithCleanup(registry.cleanup.bind(registry), registry.cleanupByPrefix.bind(registry)),
    registerSubscriptionCleanup: registry.register.bind(registry),
    onMobileSessionTabsChanged: () => () => {}
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const ends: Record<string, number> = { 'sub-old': 0, 'sub-new': 0 }
  for (const id of ['sub-old', 'sub-new']) {
    await dispatcher.dispatchStreaming(
      { ...request('session.tabs.subscribe', { worktree: 'id:wt-1' }), id },
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
  cleanupSubscriptionsByPrefix: (prefix: string) => void = vi.fn()
): OrcaRuntimeService {
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
    cleanupSubscriptionsByPrefix
  } as unknown as OrcaRuntimeService
}

function request(method: string, params: unknown) {
  return { id: 'request-a', authToken: 'token-a', method, params }
}
