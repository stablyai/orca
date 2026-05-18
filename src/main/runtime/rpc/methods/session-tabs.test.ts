import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab RPC methods', () => {
  it('streams all known session tab snapshots and later updates', async () => {
    const unsubscribe = vi.fn()
    const listeners: ((snapshot: unknown) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAllMobileSessionTabs: vi.fn(() => [
        {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        {
          worktree: 'wt-2',
          publicationEpoch: 'epoch-2',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]),
      onMobileSessionTabsChanged: vi.fn((listener: (snapshot: unknown) => void) => {
        listeners.push(listener)
        return unsubscribe
      }),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )
    listeners[0]?.({
      worktree: 'wt-1',
      publicationEpoch: 'epoch-3',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*',
      expect.any(Function),
      'conn-1'
    )
    expect(runtime.onMobileSessionTabsChanged).toHaveBeenCalledTimes(1)
    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      {
        type: 'snapshots',
        snapshots: [
          expect.objectContaining({ worktree: 'wt-1' }),
          expect.objectContaining({ worktree: 'wt-2' })
        ]
      },
      expect.objectContaining({ type: 'updated', worktree: 'wt-1', snapshotVersion: 2 })
    ])
  })

  it('unsubscribes a session tabs stream using the resolved worktree id and connection id', async () => {
    const cleanupSubscription = vi.fn()
    const runtime = {
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
      cleanupSubscription
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.unsubscribe', { worktree: 'id:wt-1' }),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )

    expect(cleanupSubscription).toHaveBeenCalledWith('session.tabs:conn-1:wt-1')
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: true,
      result: { unsubscribed: true }
    })
  })
})
