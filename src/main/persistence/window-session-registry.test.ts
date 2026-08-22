import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { mergeWindowSessions } from './window-session-merge'
import { WindowSessionRegistry } from './window-session-registry'

function makeTab(id: string, worktreeId: string) {
  return {
    id,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ptyId: `pty-${id}`
  }
}

function makeSession(
  activeTabId: string,
  options: { revision?: number; scrollbackRef?: string; worktreeId?: string } = {}
): WorkspaceSessionState {
  const worktreeId = options.worktreeId ?? 'repo-1::/worktree'
  const leafId = `leaf-${activeTabId}`
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: worktreeId,
    activeTabId,
    tabsByWorktree: { [worktreeId]: [makeTab(activeTabId, worktreeId)] },
    terminalLayoutsByTabId: {
      [activeTabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: `pty-${activeTabId}` },
        ...(options.scrollbackRef
          ? { scrollbackRefsByLeafId: { [leafId]: options.scrollbackRef } }
          : {})
      }
    },
    terminalTopologyRevisionByRepoId: { 'repo-1': options.revision ?? 0 }
  }
}

function layoutGroupIds(layout: TabGroupLayoutNode): string[] {
  return layout.type === 'leaf'
    ? [layout.groupId]
    : [...layoutGroupIds(layout.first), ...layoutGroupIds(layout.second)]
}

function makeHarness(controlWindowId = 1) {
  const sessions = new Map<string, WorkspaceSessionState>()
  const store = {
    getWorkspaceSession: vi.fn(
      (hostId?: string | null) => sessions.get(hostId ?? 'local') ?? getDefaultWorkspaceSession()
    ),
    setWorkspaceSession: vi.fn((state: WorkspaceSessionState, hostId?: string | null) => {
      sessions.set(hostId ?? 'local', structuredClone(state))
    }),
    stageWorkspaceSessionBeforeUnload: vi.fn(),
    patchWorkspaceSession: vi.fn()
  }
  const manager = {
    getControlWindow: vi.fn<() => { id: number } | null>(() => ({ id: controlWindowId }))
  }
  return { manager, sessions, store }
}

describe('WindowSessionRegistry', () => {
  it('does not expose mutable references from window records', () => {
    const control = makeSession('tab-control')
    const secondary = makeSession('tab-secondary')
    const before = structuredClone(control)

    const merged = mergeWindowSessions([control, secondary])
    merged.tabsByWorktree['repo-1::/worktree'][0]!.title = 'mutated'
    merged.terminalLayoutsByTabId['tab-control']!.ptyIdsByLeafId!['leaf-tab-control'] = 'mutated'

    expect(control).toEqual(before)
  })

  it('unions terminal membership while the control window owns active/layout conflicts', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const control = makeSession('tab-control', { revision: 2 })
    const secondary = makeSession('tab-secondary', { revision: 7 })
    control.activeTabIdByWorktree = { [control.activeWorktreeId!]: 'tab-control' }
    secondary.activeTabIdByWorktree = { [secondary.activeWorktreeId!]: 'tab-secondary' }
    control.tabGroups = {
      [control.activeWorktreeId!]: [
        {
          id: 'shared-group',
          worktreeId: control.activeWorktreeId!,
          activeTabId: 'tab-control',
          tabOrder: ['tab-control']
        }
      ]
    }
    secondary.tabGroups = {
      [secondary.activeWorktreeId!]: [
        {
          id: 'shared-group',
          worktreeId: secondary.activeWorktreeId!,
          activeTabId: 'tab-secondary',
          tabOrder: ['tab-secondary']
        }
      ]
    }
    registry.set(1, control, 'local')
    registry.set(2, secondary, 'local')

    const merged = registry.mergeHost('local')

    expect(merged.activeTabId).toBe('tab-control')
    expect(merged.activeTabIdByWorktree?.['repo-1::/worktree']).toBe('tab-control')
    expect(merged.tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-control',
      'tab-secondary'
    ])
    expect(Object.keys(merged.terminalLayoutsByTabId)).toEqual(['tab-control', 'tab-secondary'])
    expect(merged.tabGroups?.['repo-1::/worktree'][0]).toMatchObject({
      activeTabId: 'tab-control',
      tabOrder: ['tab-control', 'tab-secondary']
    })
    expect(merged.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 7 })
  })

  it('unions window-owned tab backing records, history, and group layouts', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const control = makeSession('tab-control')
    const secondary = makeSession('tab-secondary')
    const worktreeId = control.activeWorktreeId!
    control.openFilesByWorktree = {
      [worktreeId]: [
        {
          filePath: '/workspace/control.ts',
          relativePath: 'control.ts',
          worktreeId,
          language: 'typescript'
        }
      ]
    }
    secondary.openFilesByWorktree = {
      [worktreeId]: [
        {
          filePath: '/workspace/secondary.ts',
          relativePath: 'secondary.ts',
          worktreeId,
          language: 'typescript'
        }
      ]
    }
    const browserWorkspace = (id: string) => ({
      id,
      worktreeId,
      url: `https://${id}.example.com`,
      title: id,
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    })
    control.browserTabsByWorktree = { [worktreeId]: [browserWorkspace('control-browser')] }
    secondary.browserTabsByWorktree = { [worktreeId]: [browserWorkspace('secondary-browser')] }
    control.browserUrlHistory = [
      {
        url: 'https://control.example.com',
        normalizedUrl: 'https://control.example.com',
        title: 'control',
        lastVisitedAt: 2,
        visitCount: 1
      }
    ]
    secondary.browserUrlHistory = [
      {
        url: 'https://secondary.example.com',
        normalizedUrl: 'https://secondary.example.com',
        title: 'secondary',
        lastVisitedAt: 1,
        visitCount: 1
      }
    ]
    control.tabGroups = {
      [worktreeId]: [
        { id: 'control-group', worktreeId, activeTabId: 'tab-control', tabOrder: ['tab-control'] }
      ]
    }
    secondary.tabGroups = {
      [worktreeId]: [
        {
          id: 'secondary-group',
          worktreeId,
          activeTabId: 'tab-secondary',
          tabOrder: ['tab-secondary']
        }
      ]
    }
    control.tabGroupLayouts = { [worktreeId]: { type: 'leaf', groupId: 'control-group' } }
    secondary.tabGroupLayouts = { [worktreeId]: { type: 'leaf', groupId: 'secondary-group' } }
    registry.set(1, control)
    registry.set(2, secondary)

    const merged = registry.mergeHost()

    expect(merged.openFilesByWorktree?.[worktreeId].map((file) => file.filePath)).toEqual([
      '/workspace/control.ts',
      '/workspace/secondary.ts'
    ])
    expect(merged.browserTabsByWorktree?.[worktreeId].map((tab) => tab.id)).toEqual([
      'control-browser',
      'secondary-browser'
    ])
    expect(merged.browserUrlHistory?.map((entry) => entry.normalizedUrl)).toEqual([
      'https://control.example.com',
      'https://secondary.example.com'
    ])
    expect(layoutGroupIds(merged.tabGroupLayouts![worktreeId])).toEqual([
      'control-group',
      'secondary-group'
    ])
  })

  it('keeps local and SSH records in separate host partitions', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('local-tab'), 'local')
    registry.set(1, makeSession('ssh-tab'), 'ssh:server-1')

    expect(registry.get(1, 'local').activeTabId).toBe('local-tab')
    expect(registry.get(1, 'ssh:server-1').activeTabId).toBe('ssh-tab')
    expect(registry.mergeHost('local').tabsByWorktree['repo-1::/worktree'][0]?.id).toBe('local-tab')
    expect(registry.mergeHost('ssh:server-1').tabsByWorktree['repo-1::/worktree'][0]?.id).toBe(
      'ssh-tab'
    )
  })

  it('preserves pane incarnations and tombstones with control conflict precedence', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const control = makeSession('tab-control')
    const secondary = makeSession('tab-secondary')
    const tombstone = (parentTabId: string, incarnationId: string) => ({
      worktreeId: 'repo-1::/worktree',
      parentTabId,
      leafId: `leaf-${parentTabId}`,
      ptyId: `pty-${parentTabId}`,
      incarnationId,
      retiredAt: 1
    })
    control.terminalPtyIncarnationsByPaneKey = {
      shared: 'control-incarnation',
      'tab-control:leaf-tab-control': 'control-only'
    }
    secondary.terminalPtyIncarnationsByPaneKey = {
      shared: 'secondary-incarnation',
      'tab-secondary:leaf-tab-secondary': 'secondary-only'
    }
    control.terminalSurfaceTombstonesByPaneKey = {
      shared: tombstone('tab-control', 'control-incarnation')
    }
    secondary.terminalSurfaceTombstonesByPaneKey = {
      shared: tombstone('tab-secondary', 'secondary-incarnation'),
      secondary: tombstone('tab-secondary', 'secondary-only')
    }
    registry.set(1, control)
    registry.set(2, secondary)

    const merged = registry.mergeHost()

    expect(merged.terminalPtyIncarnationsByPaneKey).toEqual({
      shared: 'control-incarnation',
      'tab-control:leaf-tab-control': 'control-only',
      'tab-secondary:leaf-tab-secondary': 'secondary-only'
    })
    expect(merged.terminalSurfaceTombstonesByPaneKey).toEqual({
      shared: tombstone('tab-control', 'control-incarnation'),
      secondary: tombstone('tab-secondary', 'secondary-only')
    })
  })

  it('persists the target scrollback reference before the source record drops it', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const source = makeSession('tab-1', { scrollbackRef: 'scrollback/ref-1' })
    registry.set(1, source)
    registry.set(2, source)
    registry.set(1, getDefaultWorkspaceSession())

    const writes = store.setWorkspaceSession.mock.calls.map(([state]) => state)
    const targetPrepared = writes.at(-2) as WorkspaceSessionState
    const sourceRemoved = writes.at(-1) as WorkspaceSessionState
    expect(
      Object.values(targetPrepared.terminalLayoutsByTabId['tab-1']?.scrollbackRefsByLeafId ?? {})
    ).toContain('scrollback/ref-1')
    expect(
      Object.values(sourceRemoved.terminalLayoutsByTabId['tab-1']?.scrollbackRefsByLeafId ?? {})
    ).toContain('scrollback/ref-1')
  })

  it('patches one window record then writes the merged host session', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))

    registry.patch(1, { activeTabId: 'tab-updated' })

    expect(registry.get(1).activeTabId).toBe('tab-updated')
    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTabId: 'tab-updated' }),
      'local'
    )
  })

  it('retires closed windows but preserves their last record after quit freeze', () => {
    const { manager, store } = makeHarness(2)
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))
    registry.set(2, makeSession('tab-2'))
    registry.retire(1, 'user-close')
    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-2'
    ])

    registry.set(1, makeSession('tab-1'))
    registry.freezeForQuit()
    registry.retire(1, 'user-close')
    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-2',
      'tab-1'
    ])

    registry.resumeAfterQuitAbort()
    registry.retire(1, 'user-close')
    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-2'
    ])
  })

  it('persists an empty host snapshot after its last window retires', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))

    registry.retire(1, 'user-close')

    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabsByWorktree: {}, terminalLayoutsByTabId: {} }),
      'local'
    )
    expect(registry.mergeHost().tabsByWorktree).toEqual({})
  })

  it('uses the pending control candidate while the old control retires', () => {
    const { manager, store } = makeHarness()
    manager.getControlWindow.mockReturnValue(null)
    const registry = new WindowSessionRegistry(
      store as never,
      { ...manager, getMostRecentWindow: () => ({ id: 3 }) } as never
    )
    registry.set(1, makeSession('tab-old-control'))
    registry.set(2, makeSession('tab-older-secondary'))
    registry.set(3, makeSession('tab-next-control'))

    registry.retire(1, 'user-close')

    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTabId: 'tab-next-control' }),
      'local'
    )
  })

  it('makes duplicate and unknown retirement harmless', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))
    registry.retire(999, 'empty-close')
    registry.retire(1, 'empty-close')
    registry.retire(1, 'empty-close')

    expect(registry.mergeHost().tabsByWorktree).toEqual({})
    expect(store.setWorkspaceSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabsByWorktree: {} }),
      'local'
    )
  })

  it('stages only the merged host snapshot during beforeunload', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-1'))
    registry.set(2, makeSession('tab-2'))

    registry.stageBeforeUnload(2, [{ state: makeSession('tab-2') }])

    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledOnce()
    const [staged, hostId] = store.stageWorkspaceSessionBeforeUnload.mock.calls[0]
    expect(hostId).toBe('local')
    expect(staged.tabsByWorktree['repo-1::/worktree'].map((tab: { id: string }) => tab.id)).toEqual(
      ['tab-1', 'tab-2']
    )
  })
})
