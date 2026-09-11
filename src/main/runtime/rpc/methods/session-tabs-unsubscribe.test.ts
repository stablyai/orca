import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
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
})

function runtimeWithCleanup(
  cleanupSubscription: ReturnType<typeof vi.fn>,
  cleanupSubscriptionsByPrefix = vi.fn()
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
