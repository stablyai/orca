import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../shared/types'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { IPtyProvider } from '../providers/types'
import { OrcaRuntimeService } from './orca-runtime'

const { deleteWorktreeHistoryDirMock, listRegisteredPtysMock } = vi.hoisted(() => ({
  deleteWorktreeHistoryDirMock: vi.fn(),
  listRegisteredPtysMock: vi.fn(() => [])
}))

vi.mock('../terminal-history-deletion', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

const ROOT_GROUP_ID = 'group-root'
const CHILD_GROUP_ID = 'group-child'
const SIBLING_GROUP_ID = 'group-sibling'

function makeGroup(id: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: '/workspace',
    connectionId: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorkspace(
  id: string,
  projectGroupId: string,
  connectionId: string | null = null
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

type ProcessRow = {
  id: string
  worktreeId: string
  cwd: string
  title: string
}

function makeProvider(initialRows: ProcessRow[], events: string[] = []) {
  let rows = [...initialRows]
  const listProcesses = vi.fn(async () => [...rows])
  const shutdown = vi.fn(async (ptyId: string) => {
    events.push(`stop:${ptyId}`)
    rows = rows.filter((row) => row.id !== ptyId)
  })
  return {
    provider: { listProcesses, shutdown } as unknown as IPtyProvider,
    listProcesses,
    shutdown,
    rows: () => rows
  }
}

function processRows(workspaceId: string, count: number): ProcessRow[] {
  const workspaceKey = folderWorkspaceKey(workspaceId)
  return Array.from({ length: count }, (_, index) => ({
    id: `${workspaceKey}@@pty-${index}`,
    worktreeId: workspaceKey,
    cwd: `/workspace/${workspaceId}`,
    title: 'shell'
  }))
}

function makeMobileSnapshot(
  worktree: string,
  snapshotVersion = 1
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:folder-deletion',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: 'tab::leaf',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        parentTabId: 'tab',
        leafId: 'leaf',
        title: `Terminal ${worktree}`,
        isActive: true
      }
    ]
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function syncGraphPtys(
  runtime: OrcaRuntimeService,
  workspaceKey: string,
  ptyIds: readonly string[]
): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: ptyIds.map((_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: workspaceKey,
      title: 'shell',
      activeLeafId: `pane:${index}`,
      layout: null
    })),
    leaves: ptyIds.map((ptyId, index) => ({
      tabId: `tab-${index}`,
      worktreeId: workspaceKey,
      leafId: `pane:${index}`,
      paneRuntimeId: index,
      ptyId,
      paneTitle: null
    }))
  })
}

function createRuntime(args: {
  groups: ProjectGroup[]
  workspaces: FolderWorkspace[]
  localProvider: IPtyProvider
  sshProviders?: Map<string, IPtyProvider>
  getSshProvider?: (connectionId: string) => IPtyProvider | undefined
  repos?: Repo[]
  events?: string[]
}) {
  let groups = [...args.groups]
  let workspaces = [...args.workspaces]
  let createdWorkspaceCount = 0
  const events = args.events ?? []
  const createFolderWorkspace = vi.fn(
    (input: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
    }) => {
      const group = groups.find((candidate) => candidate.id === input.projectGroupId)
      const folderPath = input.folderPath ?? group?.parentPath
      if (!group || !folderPath) {
        throw new Error('Folder-backed project group not found.')
      }
      createdWorkspaceCount += 1
      const workspace = {
        ...makeWorkspace(`created-${createdWorkspaceCount}`, group.id, input.connectionId ?? null),
        name: input.name ?? `${group.name} workspace`,
        folderPath
      }
      workspaces = [workspace, ...workspaces]
      return workspace
    }
  )
  const removeFolderWorkspace = vi.fn((workspaceId: string) => {
    const before = workspaces.length
    workspaces = workspaces.filter((workspace) => workspace.id !== workspaceId)
    if (workspaces.length === before) {
      return false
    }
    events.push(`metadata:${workspaceId}`)
    return true
  })
  const deleteProjectGroup = vi.fn((groupId: string) => {
    if (!groups.some((group) => group.id === groupId)) {
      return false
    }
    const deletedGroupIds = getProjectGroupSubtreeIds(groups, groupId)
    groups = groups.filter((group) => !deletedGroupIds.has(group.id))
    workspaces = workspaces.filter((workspace) => !deletedGroupIds.has(workspace.projectGroupId))
    events.push(`metadata-group:${groupId}`)
    return true
  })
  const store = {
    getRepos: () => args.repos ?? [],
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => workspaces,
    createFolderWorkspace,
    removeFolderWorkspace,
    deleteProjectGroup,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => ({}),
    removeWorktreeMeta: () => false,
    getSettings: () => ({})
  } as never
  const onPtyStopped = vi.fn()
  const runtime = new OrcaRuntimeService(store, undefined, {
    getLocalProvider: () => args.localProvider,
    getSshProvider: args.getSshProvider ?? ((connectionId) => args.sshProviders?.get(connectionId)),
    onPtyStopped
  })
  const reposChanged = vi.fn()
  runtime.setNotifier({ reposChanged } as never)
  return {
    runtime,
    groups: () => groups,
    workspaces: () => workspaces,
    createFolderWorkspace,
    removeFolderWorkspace,
    deleteProjectGroup,
    onPtyStopped,
    reposChanged
  }
}

beforeEach(() => {
  deleteWorktreeHistoryDirMock.mockReset()
  listRegisteredPtysMock.mockReset()
  listRegisteredPtysMock.mockReturnValue([])
})

describe('folder workspace deletion teardown', () => {
  it('stops every owned local PTY and preserves a sibling workspace', async () => {
    const first = makeWorkspace('workspace-a', ROOT_GROUP_ID)
    const sibling = makeWorkspace('workspace-b', ROOT_GROUP_ID)
    const events: string[] = []
    const provider = makeProvider(
      [...processRows(first.id, 2), ...processRows(sibling.id, 1)],
      events
    )
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [first, sibling],
      localProvider: provider.provider,
      events
    })
    const firstKey = folderWorkspaceKey(first.id)
    const siblingKey = folderWorkspaceKey(sibling.id)
    const closeTab = vi.fn().mockResolvedValue(undefined)
    fixture.runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab })
    fixture.runtime.setAgentBrowserBridge({
      tabList: vi.fn((worktreeId: string) => ({
        tabs:
          worktreeId === firstKey
            ? [{ browserPageId: 'page-a' }]
            : worktreeId === siblingKey
              ? [{ browserPageId: 'page-b' }]
              : []
      }))
    } as never)
    const internals = fixture.runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      acceptedRendererMobileSnapshotByWorktree: Map<string, unknown>
    }
    internals.mobileSessionTabsByWorktree.set(firstKey, {})
    internals.mobileSessionTabsByWorktree.set(siblingKey, {})
    internals.acceptedRendererMobileSnapshotByWorktree.set(firstKey, {})
    internals.acceptedRendererMobileSnapshotByWorktree.set(siblingKey, {})

    await expect(fixture.runtime.deleteFolderWorkspace(first.id)).resolves.toEqual({
      deleted: true
    })

    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    expect(provider.shutdown.mock.calls.map(([ptyId]) => ptyId).sort()).toEqual(
      processRows(first.id, 2)
        .map((row) => row.id)
        .sort()
    )
    expect(provider.rows()).toEqual(processRows(sibling.id, 1))
    expect(fixture.workspaces()).toEqual([sibling])
    expect(events[0]).toBe(`metadata:${first.id}`)
    expect(fixture.reposChanged).toHaveBeenCalledTimes(1)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(firstKey)
    expect(internals.mobileSessionTabsByWorktree.has(firstKey)).toBe(false)
    expect(internals.mobileSessionTabsByWorktree.has(siblingKey)).toBe(true)
    expect(internals.acceptedRendererMobileSnapshotByWorktree.has(firstKey)).toBe(false)
    expect(internals.acceptedRendererMobileSnapshotByWorktree.has(siblingKey)).toBe(true)
    expect(closeTab).toHaveBeenCalledWith('page-a')
    expect(closeTab).not.toHaveBeenCalledWith('page-b')
  })

  it('rejects a stale mixed graph as soon as folder metadata is deleted', async () => {
    const deletedWorkspace = makeWorkspace('workspace-a', ROOT_GROUP_ID)
    const survivingWorkspace = makeWorkspace('workspace-b', ROOT_GROUP_ID)
    const inventoryStarted = deferred()
    const releaseInventory = deferred()
    const provider = {
      listProcesses: vi.fn(async () => {
        inventoryStarted.resolve()
        await releaseInventory.promise
        return []
      }),
      shutdown: vi.fn()
    } as unknown as IPtyProvider
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [deletedWorkspace, survivingWorkspace],
      localProvider: provider
    })
    const deletedKey = folderWorkspaceKey(deletedWorkspace.id)
    const survivingKey = folderWorkspaceKey(survivingWorkspace.id)
    const gitWorktreeId = 'folder::/tmp/worktree'
    fixture.runtime.attachWindow(1)
    const deletion = fixture.runtime.deleteFolderWorkspace(deletedWorkspace.id)

    await inventoryStarted.promise
    try {
      expect(fixture.workspaces()).toEqual([survivingWorkspace])
      const result = fixture.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'deleted-tab',
            worktreeId: deletedKey,
            title: 'deleted',
            activeLeafId: 'deleted-leaf',
            layout: null
          },
          {
            tabId: 'surviving-tab',
            worktreeId: survivingKey,
            title: 'surviving',
            activeLeafId: 'surviving-leaf',
            layout: null
          },
          {
            tabId: 'git-tab',
            worktreeId: gitWorktreeId,
            title: 'git',
            activeLeafId: 'git-leaf',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'deleted-tab',
            worktreeId: deletedKey,
            leafId: 'deleted-leaf',
            paneRuntimeId: 1,
            ptyId: 'deleted-pty'
          },
          {
            tabId: 'surviving-tab',
            worktreeId: survivingKey,
            leafId: 'surviving-leaf',
            paneRuntimeId: 2,
            ptyId: 'surviving-pty'
          },
          {
            tabId: 'git-tab',
            worktreeId: gitWorktreeId,
            leafId: 'git-leaf',
            paneRuntimeId: 3,
            ptyId: 'git-pty'
          }
        ],
        mobileSessionTabs: [
          makeMobileSnapshot(deletedKey),
          makeMobileSnapshot(survivingKey),
          makeMobileSnapshot(gitWorktreeId)
        ],
        unchangedMobileSessionWorktrees: [deletedKey]
      })
      const internals = fixture.runtime as unknown as {
        tabs: Map<string, { worktreeId: string }>
        leaves: Map<string, { worktreeId: string }>
        ptysById: Map<string, { worktreeId: string }>
        mobileSessionTabsByWorktree: Map<string, unknown>
        acceptedRendererMobileSnapshotByWorktree: Map<string, unknown>
      }

      expect(result.graphStatus).toBe('ready')
      expect(result.mobileSessionResyncWorktrees).toBeUndefined()
      expect([...internals.tabs.values()].map((tab) => tab.worktreeId)).toEqual([
        survivingKey,
        gitWorktreeId
      ])
      expect([...internals.leaves.values()].map((leaf) => leaf.worktreeId)).toEqual([
        survivingKey,
        gitWorktreeId
      ])
      expect([...internals.ptysById.values()].map((pty) => pty.worktreeId)).toEqual([
        survivingKey,
        gitWorktreeId
      ])
      expect([...internals.mobileSessionTabsByWorktree.keys()]).toEqual([
        survivingKey,
        gitWorktreeId
      ])
      expect([...internals.acceptedRendererMobileSnapshotByWorktree.keys()]).toEqual([
        survivingKey,
        gitWorktreeId
      ])
    } finally {
      releaseInventory.resolve()
      await deletion
    }
  })

  it('emits one removal tombstone, cancels pending publication, and forgets selections', async () => {
    vi.useFakeTimers()
    try {
      const workspace = makeWorkspace('workspace-a', ROOT_GROUP_ID)
      const workspaceKey = folderWorkspaceKey(workspace.id)
      const fixture = createRuntime({
        groups: [makeGroup(ROOT_GROUP_ID)],
        workspaces: [workspace],
        localProvider: makeProvider([]).provider
      })
      const events: RuntimeMobileSessionTabsResult[] = []
      fixture.runtime.onMobileSessionTabsChanged((event) => events.push(event), 'client-a')
      const internals = fixture.runtime as unknown as {
        clientSessionTabSelections: {
          hydrate: (state: Record<string, unknown>) => void
          serialize: () => Record<string, unknown>
        }
        mobileSessionTabsByWorktree: Map<string, unknown>
        acceptedRendererMobileSnapshotByWorktree: Map<string, unknown>
      }
      internals.clientSessionTabSelections.hydrate({
        'client-a': {
          [workspaceKey]: {
            activeTabId: 'tab::leaf',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      })
      fixture.runtime.attachWindow(1)
      fixture.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab',
            worktreeId: workspaceKey,
            title: 'terminal',
            activeLeafId: 'leaf',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab',
            worktreeId: workspaceKey,
            leafId: 'leaf',
            paneRuntimeId: 1,
            ptyId: null
          }
        ],
        mobileSessionTabs: [makeMobileSnapshot(workspaceKey)]
      })

      await fixture.runtime.deleteFolderWorkspace(workspace.id)

      expect(events).toEqual([
        expect.objectContaining({ worktree: workspaceKey, removed: true, tabs: [] })
      ])
      expect(internals.mobileSessionTabsByWorktree.has(workspaceKey)).toBe(false)
      expect(internals.acceptedRendererMobileSnapshotByWorktree.has(workspaceKey)).toBe(false)
      expect(internals.clientSessionTabSelections.serialize()).toEqual({})

      vi.advanceTimersByTime(500)
      expect(events).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires proven PTYs but keeps unproven processes discoverable without graph handles', async () => {
    for (const didStop of [true, false]) {
      const workspace = makeWorkspace(`workspace-${didStop}`, ROOT_GROUP_ID)
      const workspaceKey = folderWorkspaceKey(workspace.id)
      const ptyId = `${workspaceKey}@@pty`
      const fixture = createRuntime({
        groups: [makeGroup(ROOT_GROUP_ID)],
        workspaces: [workspace],
        localProvider: makeProvider([]).provider
      })
      const handle = fixture.runtime.preAllocateHandleForPty(ptyId)
      syncGraphPtys(fixture.runtime, workspaceKey, [ptyId])
      fixture.runtime.setPtyController({
        write: () => true,
        kill: () => true,
        stopAndWait: vi.fn(async () => {
          if (didStop) {
            fixture.runtime.onPtyExit(ptyId, 0)
          }
          return didStop
        }),
        getForegroundProcess: async () => null
      })

      await fixture.runtime.deleteFolderWorkspace(workspace.id)

      const internals = fixture.runtime as unknown as {
        tabs: Map<string, { worktreeId: string }>
        leaves: Map<string, { worktreeId: string }>
        ptysById: Map<string, { connected: boolean; paneKey: string | null; tabId: string | null }>
        handles: Map<string, unknown>
        handleByPtyId: Map<string, string>
      }
      expect([...internals.tabs.values()]).toEqual([])
      expect([...internals.leaves.values()]).toEqual([])
      expect(internals.handles.has(handle)).toBe(false)
      expect(internals.handleByPtyId.has(ptyId)).toBe(false)
      expect(fixture.runtime.resolveLeafForHandle(handle)).toBeNull()
      if (didStop) {
        expect(internals.ptysById.has(ptyId)).toBe(false)
      } else {
        expect(internals.ptysById.get(ptyId)).toEqual(
          expect.objectContaining({ connected: true, paneKey: null, tabId: null })
        )
      }
    }
  })

  it('uses only the owning direct-SSH provider and skips the local registry', async () => {
    const workspace = makeWorkspace('workspace-ssh', ROOT_GROUP_ID, 'ssh-1')
    const remoteProvider = makeProvider(processRows(workspace.id, 2))
    const localProvider = makeProvider(processRows(workspace.id, 1))
    const fixture = createRuntime({
      groups: [{ ...makeGroup(ROOT_GROUP_ID), connectionId: 'ssh-1' }],
      workspaces: [workspace],
      localProvider: localProvider.provider,
      sshProviders: new Map([['ssh-1', remoteProvider.provider]])
    })

    await expect(fixture.runtime.deleteFolderWorkspace(workspace.id)).resolves.toEqual({
      deleted: true
    })

    expect(remoteProvider.listProcesses).toHaveBeenCalledTimes(1)
    expect(remoteProvider.shutdown).toHaveBeenCalledTimes(2)
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(listRegisteredPtysMock).not.toHaveBeenCalled()
  })

  it('fences local graph cleanup from a same-key SSH PTY', async () => {
    const workspace = makeWorkspace('workspace-local', ROOT_GROUP_ID)
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [workspace],
      localProvider: makeProvider([]).provider
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncGraphPtys(fixture.runtime, workspaceKey, ['local-graph-pty', 'ssh:ssh-1@@remote-graph-pty'])

    await fixture.runtime.deleteFolderWorkspace(workspace.id)

    expect(stopAndWait).toHaveBeenCalledWith('local-graph-pty', expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith('ssh:ssh-1@@remote-graph-pty', expect.anything())
  })

  it('infers direct-SSH ownership for graph PTYs without runtime records', async () => {
    const workspace = makeWorkspace('workspace-ssh', ROOT_GROUP_ID, 'ssh-1')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const remoteProvider = makeProvider([])
    const fixture = createRuntime({
      groups: [{ ...makeGroup(ROOT_GROUP_ID), connectionId: 'ssh-1' }],
      workspaces: [workspace],
      localProvider: makeProvider([]).provider,
      sshProviders: new Map([['ssh-1', remoteProvider.provider]])
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncGraphPtys(fixture.runtime, workspaceKey, ['local-graph-pty', 'ssh:ssh-1@@remote-graph-pty'])

    await fixture.runtime.deleteFolderWorkspace(workspace.id)

    expect(stopAndWait).toHaveBeenCalledWith('ssh:ssh-1@@remote-graph-pty', expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith('local-graph-pty', expect.anything())
  })

  it('does not re-list provider-stopped graph PTYs', async () => {
    const workspace = makeWorkspace('workspace-local', ROOT_GROUP_ID)
    const [row] = processRows(workspace.id, 1)
    const provider = makeProvider([row!])
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [workspace],
      localProvider: provider.provider
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    fixture.runtime.registerPty(row!.id, row!.worktreeId, null)

    await fixture.runtime.deleteFolderWorkspace(workspace.id)

    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    expect(provider.shutdown).toHaveBeenCalledWith(row!.id, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('batches a project-group subtree into one provider inventory', async () => {
    const first = makeWorkspace('workspace-a', ROOT_GROUP_ID)
    const second = makeWorkspace('workspace-b', CHILD_GROUP_ID)
    const sibling = makeWorkspace('workspace-c', SIBLING_GROUP_ID)
    const events: string[] = []
    const provider = makeProvider(
      [...processRows(first.id, 2), ...processRows(second.id, 2), ...processRows(sibling.id, 2)],
      events
    )
    const fixture = createRuntime({
      groups: [
        makeGroup(ROOT_GROUP_ID),
        makeGroup(CHILD_GROUP_ID, ROOT_GROUP_ID),
        makeGroup(SIBLING_GROUP_ID)
      ],
      workspaces: [first, second, sibling],
      localProvider: provider.provider,
      events
    })
    fixture.runtime.attachWindow(1)
    fixture.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await expect(fixture.runtime.deleteProjectGroup(ROOT_GROUP_ID)).resolves.toEqual({
      deleted: true
    })

    expect(provider.listProcesses).toHaveBeenCalledTimes(1)
    expect(provider.shutdown.mock.calls.map(([ptyId]) => ptyId).sort()).toEqual(
      [...processRows(first.id, 2), ...processRows(second.id, 2)].map((row) => row.id).sort()
    )
    expect(provider.rows()).toEqual(processRows(sibling.id, 2))
    expect(fixture.groups().map((group) => group.id)).toEqual([SIBLING_GROUP_ID])
    expect(fixture.workspaces()).toEqual([sibling])
    expect(events[0]).toBe(`metadata-group:${ROOT_GROUP_ID}`)
    expect(fixture.reposChanged).toHaveBeenCalledTimes(1)

    fixture.runtime.syncWindowGraph(1, {
      tabs: [first, second, sibling].map((workspace) => ({
        tabId: `tab-${workspace.id}`,
        worktreeId: folderWorkspaceKey(workspace.id),
        title: workspace.name,
        activeLeafId: null,
        layout: null
      })),
      leaves: []
    })
    const graphTabs = (fixture.runtime as unknown as { tabs: Map<string, { worktreeId: string }> })
      .tabs
    expect([...graphTabs.values()].map((tab) => tab.worktreeId)).toEqual([
      folderWorkspaceKey(sibling.id)
    ])
  })

  it('rejects a folder spawn after its deletion lease releases', async () => {
    const workspace = makeWorkspace('workspace-a', ROOT_GROUP_ID)
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [workspace],
      localProvider: makeProvider([]).provider
    })

    await fixture.runtime.deleteFolderWorkspace(workspace.id)

    await expect(
      fixture.runtime.acquireWorktreeTerminalSpawn(folderWorkspaceKey(workspace.id))
    ).rejects.toThrow('folder_workspace_not_found')
  })

  it('serializes the final folder create mutation behind project-group deletion', async () => {
    const workspace = makeWorkspace('workspace-a', ROOT_GROUP_ID)
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [workspace],
      localProvider: makeProvider([]).provider
    })
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const internals = fixture.runtime as unknown as {
      terminalMutationTailByWorktreeId: Map<string, Promise<void>>
    }
    const releaseBlocker = await fixture.runtime.acquireWorktreeTerminalSpawn(workspaceKey)
    const blockerTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
    const deletion = fixture.runtime.deleteProjectGroup(ROOT_GROUP_ID)
    await vi.waitFor(() =>
      expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(blockerTail)
    )

    const creation = fixture.runtime.createFolderWorkspace({
      projectGroupId: ROOT_GROUP_ID,
      folderPath: process.cwd(),
      connectionId: null
    })
    void creation.catch(() => {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fixture.createFolderWorkspace).not.toHaveBeenCalled()

    releaseBlocker()

    await expect(deletion).resolves.toEqual({ deleted: true })
    await expect(creation).rejects.toThrow('Folder-backed project group not found.')
    expect(fixture.createFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(fixture.workspaces()).toEqual([])
  })

  it('does not spawn a queued background terminal after deletion returns', async () => {
    const workspace = {
      ...makeWorkspace('workspace-a', ROOT_GROUP_ID),
      folderPath: process.cwd()
    }
    const provider = makeProvider([])
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [workspace],
      localProvider: provider.provider
    })
    const spawn = vi.fn().mockResolvedValue({ id: 'late-pty' })
    fixture.runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const internals = fixture.runtime as unknown as {
      terminalMutationTailByWorktreeId: Map<string, Promise<void>>
    }
    const releaseBlocker = await fixture.runtime.acquireWorktreeTerminalSpawn(workspaceKey)
    const blockerTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
    const deletion = fixture.runtime.deleteFolderWorkspace(workspace.id)
    await vi.waitFor(() =>
      expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(blockerTail)
    )
    const deletionTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
    const creation = fixture.runtime.createTerminal(workspaceKey)
    void creation.catch(() => {})
    await vi.waitFor(() =>
      expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(deletionTail)
    )

    releaseBlocker()

    await expect(deletion).resolves.toEqual({ deleted: true })
    await expect(creation).rejects.toThrow('folder_workspace_not_found')
    expect(spawn).not.toHaveBeenCalled()
    expect(provider.rows()).toEqual([])
  })

  it('does not spawn a queued split after deletion returns', async () => {
    const workspace = {
      ...makeWorkspace('workspace-a', ROOT_GROUP_ID),
      folderPath: process.cwd()
    }
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const sourcePtyId = `${workspaceKey}@@source`
    const provider = makeProvider([
      { id: sourcePtyId, worktreeId: workspaceKey, cwd: process.cwd(), title: 'shell' }
    ])
    const fixture = createRuntime({
      groups: [makeGroup(ROOT_GROUP_ID)],
      workspaces: [workspace],
      localProvider: provider.provider
    })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: sourcePtyId })
      .mockResolvedValueOnce({ id: `${workspaceKey}@@late-split` })
    fixture.runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const source = await fixture.runtime.createTerminal(workspaceKey)
    const internals = fixture.runtime as unknown as {
      terminalMutationTailByWorktreeId: Map<string, Promise<void>>
    }
    const releaseBlocker = await fixture.runtime.acquireWorktreeTerminalSpawn(workspaceKey)
    const blockerTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
    const deletion = fixture.runtime.deleteFolderWorkspace(workspace.id)
    await vi.waitFor(() =>
      expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(blockerTail)
    )
    const deletionTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
    const split = fixture.runtime.splitTerminal(source.handle)
    void split.catch(() => {})
    await vi.waitFor(() =>
      expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(deletionTail)
    )

    releaseBlocker()

    await expect(deletion).resolves.toEqual({ deleted: true })
    await expect(split).rejects.toThrow('folder_workspace_not_found')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(provider.rows()).toEqual([])
  })
})
