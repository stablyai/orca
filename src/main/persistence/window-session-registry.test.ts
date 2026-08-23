import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
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

function makeWindowContentSession(kind: 'tab' | 'editor' | 'browser'): WorkspaceSessionState {
  const state = getDefaultWorkspaceSession()
  if (kind === 'tab') {
    state.tabsByWorktree = { 'remote-wt': [makeTab('remote-tab', 'remote-wt')] }
  } else if (kind === 'editor') {
    state.openFilesByWorktree = {
      'remote-wt': [
        {
          filePath: '/remote/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'remote-wt',
          language: 'typescript'
        }
      ]
    }
  } else {
    state.browserTabsByWorktree = {
      'remote-wt': [
        {
          id: 'remote-browser',
          worktreeId: 'remote-wt',
          url: 'https://remote.example.com',
          title: 'Remote',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    }
  }
  return state
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
    getWorkspaceSessionHostIds: vi.fn(() => [...sessions.keys()]),
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
  it('treats an empty terminal layout key as across-host durable membership', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const runtime = makeSession('runtime-tab')
    runtime.tabsByWorktree = {}
    runtime.unifiedTabs = {}
    runtime.terminalLayoutsByTabId = {
      'runtime-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }
    registry.set(2, runtime, 'runtime:env')

    expect(registry.hasWindowTerminalMembership(2)).toBe(true)

    registry.set(2, getDefaultWorkspaceSession(), 'runtime:env')
    expect(registry.hasWindowTerminalMembership(2)).toBe(false)
  })

  it('enumerates exact terminal PTYs for one window across host records', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    const local = makeSession('local-tab')
    const runtime = makeSession('runtime-tab')
    runtime.remoteSessionIdsByTabId = { 'runtime-tab': 'remote:env@@handle' }
    registry.set(2, local, 'local')
    registry.set(2, runtime, 'runtime:env')
    registry.set(1, makeSession('control-tab'), 'local')

    expect(new Set(registry.getWindowTerminalPtyIds(2))).toEqual(
      new Set(['pty-local-tab', 'pty-runtime-tab', 'remote:env@@handle'])
    )
  })

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

  it('unions leaf backing for the same terminal layout with control conflicts winning', () => {
    const control = makeSession('tab-1')
    const secondary = makeSession('tab-1')
    control.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: 'leaf-control' },
      activeLeafId: 'leaf-control',
      expandedLeafId: 'leaf-control',
      ptyIdsByLeafId: { shared: 'pty-control' },
      buffersByLeafId: { shared: 'buffer-control' },
      scrollbackRefsByLeafId: { shared: 'ref-control' },
      titlesByLeafId: { shared: 'title-control' }
    }
    secondary.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: 'leaf-secondary' },
      activeLeafId: 'leaf-secondary',
      expandedLeafId: null,
      ptyIdsByLeafId: { shared: 'pty-secondary', 'leaf-secondary': 'pty-secondary-only' },
      buffersByLeafId: { shared: 'buffer-secondary', 'leaf-secondary': 'buffer-secondary-only' },
      scrollbackRefsByLeafId: { shared: 'ref-secondary', 'leaf-secondary': 'ref-secondary-only' },
      titlesByLeafId: { shared: 'title-secondary', 'leaf-secondary': 'title-secondary-only' }
    }

    const layout = mergeWindowSessions([control, secondary]).terminalLayoutsByTabId['tab-1']

    expect(layout).toEqual({
      root: { type: 'leaf', leafId: 'leaf-control' },
      activeLeafId: 'leaf-control',
      expandedLeafId: 'leaf-control',
      ptyIdsByLeafId: { shared: 'pty-control', 'leaf-secondary': 'pty-secondary-only' },
      buffersByLeafId: { shared: 'buffer-control', 'leaf-secondary': 'buffer-secondary-only' },
      scrollbackRefsByLeafId: { shared: 'ref-control', 'leaf-secondary': 'ref-secondary-only' },
      titlesByLeafId: { shared: 'title-control', 'leaf-secondary': 'title-secondary-only' }
    })
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

  it('stages every known host with the latest merged window records before quit', () => {
    const { manager, store } = makeHarness()
    store.getWorkspaceSessionHostIds.mockReturnValue(['local', 'ssh:server-1', 'runtime:folder'])
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('local-control'), 'local')
    registry.set(2, makeSession('local-secondary'), 'local')
    registry.set(2, makeSession('ssh-secondary'), 'ssh:server-1')
    registry.set(1, makeSession('folder-control'), 'runtime:folder')
    store.stageWorkspaceSessionBeforeUnload.mockClear()

    registry.stageAllKnownHostsBeforeQuit()

    const staged = new Map(
      store.stageWorkspaceSessionBeforeUnload.mock.calls.map(([state, hostId]) => [hostId, state])
    )
    expect([...staged.keys()]).toEqual(['local', 'ssh:server-1', 'runtime:folder'])
    expect(staged.get('local').tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'local-control',
      'local-secondary'
    ])
    expect(staged.get('ssh:server-1').activeTabId).toBe('ssh-secondary')
    expect(staged.get('runtime:folder').activeTabId).toBe('folder-control')
  })

  it('keeps the last verified snapshot when renderer loss is followed by window close', () => {
    const { manager, store } = makeHarness(2)
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-crashed', { scrollbackRef: 'scrollback/crashed' }))
    registry.set(2, makeSession('tab-live'))

    registry.markRendererUnavailable(1)
    registry.retire(1, 'user-close')

    const merged = registry.mergeHost()
    expect(merged.tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-live',
      'tab-crashed'
    ])
    expect(
      merged.terminalLayoutsByTabId['tab-crashed']?.scrollbackRefsByLeafId?.['leaf-tab-crashed']
    ).toBe('scrollback/crashed')
  })

  it('retires normally after a recovered renderer publishes a fresh snapshot', () => {
    const { manager, store } = makeHarness(2)
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('tab-before-crash'))
    registry.set(2, makeSession('tab-live'))
    registry.markRendererUnavailable(1)

    registry.stageBeforeUnload(1, [{ state: makeSession('tab-recovered') }])
    registry.retire(1, 'user-close')

    expect(registry.mergeHost().tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)).toEqual([
      'tab-live'
    ])
  })

  it.each([
    [
      'set',
      (registry: WindowSessionRegistry, hostId: ExecutionHostId) =>
        registry.set(1, makeSession(`fresh-${hostId}`), hostId)
    ],
    [
      'patch',
      (registry: WindowSessionRegistry, hostId: ExecutionHostId) =>
        registry.patch(1, { activeTabId: `fresh-${hostId}` }, hostId)
    ],
    [
      'beforeunload',
      (registry: WindowSessionRegistry, hostId: ExecutionHostId) =>
        registry.stageBeforeUnload(1, [{ state: makeSession(`fresh-${hostId}`), hostId }])
    ]
  ])('recovers only the checkpointed host after renderer loss via %s', (_name, checkpointHost) => {
    const { manager, store } = makeHarness(2)
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, makeSession('local-crashed'), 'local')
    registry.set(1, makeSession('ssh-crashed'), 'ssh:server-1')
    registry.set(2, makeSession('local-live'), 'local')
    registry.set(2, makeSession('ssh-live'), 'ssh:server-1')
    registry.markRendererUnavailable(1)

    checkpointHost(registry, 'local')
    registry.retire(1, 'user-close')

    expect(
      registry.mergeHost('local').tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)
    ).toEqual(['local-live'])
    expect(
      registry.mergeHost('ssh:server-1').tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)
    ).toEqual(['ssh-live', 'ssh-crashed'])

    checkpointHost(registry, 'ssh:server-1')
    registry.retire(1, 'user-close')

    expect(
      registry.mergeHost('ssh:server-1').tabsByWorktree['repo-1::/worktree'].map((tab) => tab.id)
    ).toEqual(['ssh-live'])
  })

  it.each(['tab', 'editor', 'browser'] as const)(
    'requires every host record to be empty before reporting an empty window with remote %s content',
    (kind) => {
      const { manager, store } = makeHarness()
      const registry = new WindowSessionRegistry(store as never, manager as never)
      registry.set(1, getDefaultWorkspaceSession(), 'local')
      registry.set(1, makeWindowContentSession(kind), 'ssh:server-1')

      expect(registry.isWindowEmptyAcrossHosts(1)).toBe(false)

      registry.set(1, getDefaultWorkspaceSession(), 'ssh:server-1')
      expect(registry.isWindowEmptyAcrossHosts(1)).toBe(true)
    }
  )

  it('does not report exact emptiness while any host record remains unavailable', () => {
    const { manager, store } = makeHarness()
    const registry = new WindowSessionRegistry(store as never, manager as never)
    registry.set(1, getDefaultWorkspaceSession(), 'local')
    registry.set(1, getDefaultWorkspaceSession(), 'ssh:server-1')
    registry.markRendererUnavailable(1)

    registry.set(1, getDefaultWorkspaceSession(), 'local')
    expect(registry.isWindowEmptyAcrossHosts(1)).toBe(false)

    registry.set(1, getDefaultWorkspaceSession(), 'ssh:server-1')
    expect(registry.isWindowEmptyAcrossHosts(1)).toBe(true)
  })
})
