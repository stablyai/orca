import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab RPC methods', () => {
  it('dispatches tab moves through the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn().mockResolvedValue({
        moved: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1::leaf-1',
        targetGroupId: 'group-left',
        kind: 'reorder',
        tabOrder: ['tab-2::leaf-1', 'tab-1::leaf-1']
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-1::leaf-1',
      targetGroupId: 'group-left',
      kind: 'reorder',
      tabOrder: ['tab-2::leaf-1', 'tab-1::leaf-1']
    })
  })

  it('rejects ambiguous tab move payloads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-1',
        kind: 'reorder',
        splitDirection: 'right',
        tabOrder: ['tab-1']
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.moveMobileSessionTab).not.toHaveBeenCalled()
  })

  it('dispatches split tab moves without reorder-only fields', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-2',
        kind: 'split',
        splitDirection: 'right'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-1',
      targetGroupId: 'group-2',
      kind: 'split',
      splitDirection: 'right'
    })
  })

  it('dispatches terminal creation with the requested tab group', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        targetGroupId: 'group-left',
        command: 'zsh',
        activate: true
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: 'group-left',
      command: 'zsh',
      activate: true
    })
  })

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
