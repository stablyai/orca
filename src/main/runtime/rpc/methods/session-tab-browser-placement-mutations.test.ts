import { describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'

const caller: RpcDispatchStreamingOptions = {
  clientKind: 'runtime',
  pairedDeviceId: 'legacy',
  clientCapabilities: []
}

describe('session tab browser placement mutations', () => {
  it('projects an old-client activation response and refuses hidden activation', async () => {
    const snapshot = mixedPlacementSnapshot()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot),
      activateMobileSessionTab: vi.fn().mockResolvedValue(snapshot)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const visible = await dispatch(dispatcher, 'session.tabs.activate', {
      worktree: 'id:wt-1',
      tabId: 'tab-1',
      notifyClients: false
    })
    expect(visible.result.tabs.map((tab: { id: string }) => tab.id)).toEqual([
      'tab-1::leaf-1',
      'tab-2::leaf-1'
    ])
    const hidden = await dispatch(dispatcher, 'session.tabs.activate', {
      worktree: 'id:wt-1',
      tabId: 'hidden-page',
      notifyClients: false
    })
    expect(hidden.ok).toBe(false)
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledOnce()
  })

  it('translates old-client reorder slots before dispatching to the raw runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(mixedPlacementSnapshot()),
      moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatch(dispatcher, 'session.tabs.move', {
      worktree: 'id:wt-1',
      tabId: 'tab-2',
      targetGroupId: 'group-1',
      kind: 'reorder',
      tabOrder: ['tab-2', 'tab-1']
    })

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-2',
      targetGroupId: 'group-1',
      kind: 'reorder',
      tabOrder: ['tab-2', 'hidden-page', 'tab-1']
    })
  })

  it('refuses an old-client close for a projected-out browser page', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(mixedPlacementSnapshot()),
      closeMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatch(dispatcher, 'session.tabs.close', {
      worktree: 'id:wt-1',
      tabId: 'hidden-page',
      reason: 'user'
    })

    expect(response.ok).toBe(false)
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it('keeps capable mutation callers on the unprojected path', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSessionTabs: vi.fn().mockResolvedValue(mixedPlacementSnapshot()),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatch(
      dispatcher,
      'session.tabs.close',
      { worktree: 'id:wt-1', tabId: 'hidden-page', reason: 'user' },
      {
        clientKind: 'runtime',
        pairedDeviceId: 'current',
        clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.listMobileSessionTabs).toHaveBeenCalledOnce()
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledOnce()
  })
})

async function dispatch(
  dispatcher: RpcDispatcher,
  method: string,
  params: unknown,
  context: RpcDispatchStreamingOptions = caller
) {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    { id: 'request-a', authToken: 'token-a', method, params },
    (response) => replies.push(response),
    context
  )
  return JSON.parse(replies[0]!)
}

function mixedPlacementSnapshot() {
  const terminal = (tabId: string) => ({
    type: 'terminal' as const,
    id: `${tabId}::leaf-1`,
    parentTabId: tabId,
    leafId: 'leaf-1',
    title: 'Terminal',
    status: 'ready' as const,
    terminal: `pty-${tabId}`,
    isActive: false
  })
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'hidden-page',
    activeTabType: 'browser' as const,
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'hidden-page',
        tabOrder: ['tab-1', 'hidden-page', 'tab-2']
      }
    ],
    tabs: [
      terminal('tab-1'),
      {
        type: 'browser' as const,
        id: 'hidden-page',
        title: 'Browser',
        browserWorkspaceId: 'hidden-page',
        browserPageId: 'hidden-page',
        url: 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        placement: {
          kind: 'client' as const,
          browserHostClientId: 'host-a',
          browserHostGeneration: 3,
          pageHostGeneration: 9
        },
        isActive: true
      },
      terminal('tab-2')
    ]
  }
}
