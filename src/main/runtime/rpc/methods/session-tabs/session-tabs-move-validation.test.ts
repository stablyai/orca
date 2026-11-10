import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../../shared/runtime-session-contracts'

function setMobileSessionSnapshot(
  runtime: OrcaRuntimeService,
  snapshot: RuntimeMobileSessionTabsSnapshot
): void {
  ;(
    runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
  ).mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
}

function terminalTab() {
  return {
    type: 'terminal' as const,
    id: 'terminal-tab::leaf-1',
    parentTabId: 'terminal-tab',
    leafId: 'leaf-1',
    title: 'Terminal',
    isActive: true
  }
}

function browserTab({
  id,
  workspaceId,
  pageId,
  url
}: {
  id: string
  workspaceId: string
  pageId: string
  url: string
}) {
  return {
    type: 'browser' as const,
    id,
    title: 'Browser',
    browserWorkspaceId: workspaceId,
    browserPageId: pageId,
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

describe('session tab move validation', () => {
  it('preserves a capability-hidden structured tab during an old-client reorder', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn()
    runtime.setNotifier({ moveSessionTab } as never)
    setMobileSessionSnapshot(runtime, {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-tab::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'terminal-tab',
          tabOrder: ['terminal-tab', 'agent-session:session-a', 'file-tab']
        }
      ],
      tabs: [
        terminalTab(),
        {
          type: 'agent-session',
          id: 'agent-session:session-a',
          title: 'Codex Chat',
          sessionId: 'session-a',
          agent: 'codex',
          isActive: false
        },
        {
          type: 'file',
          id: 'file-tab',
          title: 'README.md',
          filePath: 'README.md',
          relativePath: 'README.md',
          language: 'markdown',
          isDirty: false,
          isActive: false
        }
      ]
    })

    await runtime.moveMobileSessionTab('id:wt-1', {
      kind: 'reorder',
      tabId: 'file-tab',
      targetGroupId: 'group-1',
      tabOrder: ['file-tab', 'terminal-tab']
    })

    expect(moveSessionTab).toHaveBeenCalledWith('wt-1', {
      kind: 'reorder',
      tabId: 'file-tab',
      targetGroupId: 'group-1',
      tabOrder: ['file-tab', 'agent-session:session-a', 'terminal-tab']
    })
  })

  it('validates reorder moves against sanitized visible tab groups', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn()
    runtime.setNotifier({ moveSessionTab } as never)
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-live',
            title: 'Live Browser',
            url: 'https://example.test/live'
          }
        ]
      }))
    } as never)
    setMobileSessionSnapshot(runtime, {
      worktree: 'wt-1',
      publicationEpoch: 'headless:epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-tab::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'terminal-tab',
          tabOrder: ['terminal-tab', 'browser-stale', 'browser-live']
        }
      ],
      tabs: [
        terminalTab(),
        browserTab({
          id: 'browser-stale-tab',
          workspaceId: 'browser-stale',
          pageId: 'page-stale',
          url: 'https://example.test/stale'
        }),
        browserTab({
          id: 'browser-live-tab',
          workspaceId: 'browser-live',
          pageId: 'page-live',
          url: 'https://example.test/live'
        })
      ]
    })

    await expect(
      runtime.moveMobileSessionTab('id:wt-1', {
        kind: 'reorder',
        tabId: 'browser-live',
        targetGroupId: 'group-1',
        tabOrder: ['browser-live', 'terminal-tab']
      })
    ).resolves.toEqual({ moved: true })

    expect(moveSessionTab).toHaveBeenCalledWith('wt-1', {
      kind: 'reorder',
      tabId: 'browser-live-tab',
      targetGroupId: 'group-1',
      tabOrder: ['browser-live-tab', 'terminal-tab']
    })

    moveSessionTab.mockClear()
    // Renderer rows stay listed without a live page only while their window exists.
    Object.assign(runtime, { getAvailableAuthoritativeWindow: () => ({}) })
    const headlessSnapshot = runtime['mobileSessionTabsByWorktree'].get('wt-1')!
    setMobileSessionSnapshot(runtime, {
      ...headlessSnapshot,
      publicationEpoch: 'renderer:epoch-2'
    })

    await expect(
      runtime.moveMobileSessionTab('id:wt-1', {
        kind: 'reorder',
        tabId: 'browser-stale',
        targetGroupId: 'group-1',
        tabOrder: ['browser-stale', 'browser-live', 'terminal-tab']
      })
    ).resolves.toEqual({ moved: true })
    expect(moveSessionTab).toHaveBeenCalledWith('wt-1', {
      kind: 'reorder',
      tabId: 'browser-stale-tab',
      targetGroupId: 'group-1',
      tabOrder: ['browser-stale-tab', 'browser-live-tab', 'terminal-tab']
    })
  })

  it('rejects moves into groups hidden from the sanitized session model', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn()
    runtime.setNotifier({ moveSessionTab } as never)
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({ tabs: [] }))
    } as never)
    setMobileSessionSnapshot(runtime, {
      worktree: 'wt-1',
      publicationEpoch: 'headless:epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-visible',
      activeTabId: 'terminal-tab::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        { id: 'group-visible', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] },
        { id: 'group-hidden', activeTabId: 'browser-stale', tabOrder: ['browser-stale'] }
      ],
      tabs: [
        terminalTab(),
        browserTab({
          id: 'browser-stale-tab',
          workspaceId: 'browser-stale',
          pageId: 'page-stale',
          url: 'https://example.test/stale'
        })
      ]
    })

    await expect(
      runtime.moveMobileSessionTab('id:wt-1', {
        kind: 'split',
        tabId: 'terminal-tab',
        targetGroupId: 'group-hidden',
        splitDirection: 'right'
      })
    ).rejects.toThrow('target_group_not_found')
    expect(moveSessionTab).not.toHaveBeenCalled()
  })

  it('rejects reorder moves when the moved tab is absent from the target order', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn()
    runtime.setNotifier({ moveSessionTab } as never)
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({
        tabs: [{ browserPageId: 'page-live', title: 'Live Browser', url: 'https://example.test' }]
      }))
    } as never)
    setMobileSessionSnapshot(runtime, {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-tab::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        { id: 'group-1', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] },
        { id: 'group-2', activeTabId: 'browser-live', tabOrder: ['browser-live'] }
      ],
      tabs: [
        terminalTab(),
        browserTab({
          id: 'browser-live-tab',
          workspaceId: 'browser-live',
          pageId: 'page-live',
          url: 'https://example.test'
        })
      ]
    })

    await expect(
      runtime.moveMobileSessionTab('id:wt-1', {
        kind: 'reorder',
        tabId: 'browser-live',
        targetGroupId: 'group-1',
        tabOrder: ['terminal-tab']
      })
    ).rejects.toThrow('invalid_tab_order')
    expect(moveSessionTab).not.toHaveBeenCalled()
  })
})
