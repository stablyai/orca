import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab RPC methods', () => {
  it('refuses a reasonless close without invoking destructive runtime logic', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn().mockResolvedValue({
        closed: true,
        refused: true,
        snapshotRepublished: true
      }),
      closeMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { closed: true, refused: true, snapshotRepublished: true }
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith('id:wt-1', 'tab-1')
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it('preserves reasonless explicit closes from authenticated legacy mobile clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot()),
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      { clientKind: 'mobile' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('preserves reasonless closes from authenticated legacy runtime clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot()),
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'legacy-runtime' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user',
      clientNavigationId: 'legacy-runtime'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('refuses reasonless closes from runtime clients that negotiated explicit intent', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot()),
      refuseUnattributedMobileSessionTabClose: vi.fn().mockResolvedValue({
        closed: true,
        refused: true,
        refusalReason: 'missing-intent',
        snapshotRepublished: true
      }),
      closeMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      {
        clientKind: 'runtime',
        pairedDeviceId: 'current-runtime',
        clientCapabilities: [SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY]
      }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith('id:wt-1', 'tab-1')
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it.each(['pty-exit', 'cleanup'] as const)(
    'rejects %s on the legacy close endpoint before host adjudication',
    async (reason) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        closeMobileSessionTab: vi.fn()
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('session.tabs.close', {
          worktree: 'id:wt-1',
          tabId: 'tab-1',
          reason
        })
      )

      expect(response.ok).toBe(false)
      expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
    }
  )

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

  it('rejects agent prompts without an agent preset', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agentPrompt: 'Review this diff'
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Agent prompt requires an agent preset' }
    })
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('rejects unknown agent presets without creating a terminal', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agent: 'not-real'
      })
    )

    expect(response.ok).toBe(false)
    expect(response).toMatchObject({
      error: { code: 'invalid_argument', message: 'Unknown agent preset' }
    })
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('streams all known session tab snapshots and later updates', async () => {
    const unsubscribe = vi.fn()
    const listeners: ((snapshot: unknown, changeSequence: number) => void)[] = []
    const snapshots = [
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
    ]
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAllMobileSessionTabs: vi.fn(() => snapshots),
      listAllMobileSessionTabsWithChangeSequence: vi.fn(() => ({
        snapshots,
        changeSequence: 0
      })),
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => false),
      onMobileSessionTabsChanged: vi.fn(
        (listener: (snapshot: unknown, changeSequence: number) => void) => {
          listeners.push(listener)
          return unsubscribe
        }
      ),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { connectionId: 'conn-1' }
    )
    listeners[0]?.(
      {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-3',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      },
      1
    )

    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledWith(
      'session.tabs:conn-1:*:req-1',
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
})
