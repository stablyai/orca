import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'

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

function getMobileSessionSnapshot(
  runtime: OrcaRuntimeService,
  worktree: string
): RuntimeMobileSessionTabsSnapshot | undefined {
  return (
    runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
  ).mobileSessionTabsByWorktree.get(worktree)
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
  it('preserves a structured tab across renderer-authored snapshot sync', () => {
    const runtime = new OrcaRuntimeService()
    const structured = {
      type: 'agent-session' as const,
      id: 'agent-session:session-a',
      title: 'Codex Chat',
      sessionId: 'session-a',
      agent: 'codex' as const,
      isActive: false
    }
    setMobileSessionSnapshot(runtime, {
      worktree: 'wt-1',
      publicationEpoch: 'structured-epoch',
      snapshotVersion: 2,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-tab::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'terminal-tab',
          tabOrder: ['terminal-tab', structured.id]
        }
      ],
      tabs: [terminalTab(), structured]
    })
    const incoming: RuntimeMobileSessionTabsSnapshot = {
      worktree: 'wt-1',
      publicationEpoch: 'renderer-epoch',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-tab::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [{ id: 'group-1', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] }],
      tabs: [terminalTab()]
    }

    ;(
      runtime as unknown as {
        syncMobileSessionTabs(snapshots: RuntimeMobileSessionTabsSnapshot[]): Set<string>
      }
    ).syncMobileSessionTabs([incoming])

    const snapshot = getMobileSessionSnapshot(runtime, 'wt-1')
    expect(snapshot?.tabs).toContainEqual(structured)
    expect(snapshot?.tabGroups?.[0]?.tabOrder).toEqual(['terminal-tab', 'agent-session:session-a'])
  })

  it('publishes a structured tab into the active group instead of the first group', async () => {
    const runtime = new OrcaRuntimeService()
    setMobileSessionSnapshot(runtime, {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-2',
      activeTabId: 'file-tab',
      activeTabType: 'file',
      tabGroups: [
        { id: 'group-1', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] },
        { id: 'group-2', activeTabId: 'file-tab', tabOrder: ['file-tab'] }
      ],
      tabs: [
        terminalTab(),
        {
          type: 'file',
          id: 'file-tab',
          title: 'README.md',
          filePath: 'README.md',
          relativePath: 'README.md',
          language: 'markdown',
          isDirty: false,
          isActive: true
        }
      ]
    })

    await runtime.publishStructuredAgentSessionTab({
      workspaceId: 'wt-1',
      sessionId: 'session-a',
      agent: 'codex',
      activate: true
    })

    const snapshot = getMobileSessionSnapshot(runtime, 'wt-1')
    expect(snapshot?.activeGroupId).toBe('group-2')
    expect(snapshot?.tabGroups?.[0]?.tabOrder).toEqual(['terminal-tab'])
    expect(snapshot?.tabGroups?.[1]).toMatchObject({
      activeTabId: 'agent-session:session-a',
      tabOrder: ['file-tab', 'agent-session:session-a']
    })
  })

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
      publicationEpoch: 'epoch-1',
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
      publicationEpoch: 'epoch-1',
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
