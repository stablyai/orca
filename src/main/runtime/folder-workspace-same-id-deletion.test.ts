import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { IPtyProvider } from '../providers/types'
import { OrcaRuntimeService } from './orca-runtime'

const GROUP_ID = 'group-root'

function makeGroup(): ProjectGroup {
  return {
    id: GROUP_ID,
    name: GROUP_ID,
    parentPath: '/workspace',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorkspace(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: GROUP_ID,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId: null,
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

function createRuntime(workspace: FolderWorkspace): OrcaRuntimeService {
  let workspaces = [workspace]
  const provider = {
    listProcesses: vi.fn(async () => []),
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
  return new OrcaRuntimeService(
    {
      getRepos: () => [],
      getProjectGroups: () => [makeGroup()],
      getFolderWorkspaces: () => workspaces,
      removeFolderWorkspace: (workspaceId: string) => {
        const found = workspaces.some((entry) => entry.id === workspaceId)
        workspaces = workspaces.filter((entry) => entry.id !== workspaceId)
        return found
      },
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => ({}),
      removeWorktreeMeta: () => false,
      getSettings: () => ({})
    } as never,
    undefined,
    { getLocalProvider: () => provider }
  )
}

function createHostQualifiedRuntime(args: {
  groups: ProjectGroup[]
  workspaces: FolderWorkspace[]
  repos?: Repo[]
}) {
  let workspaces = [...args.workspaces]
  const getHostId = (
    scope: Pick<ProjectGroup | FolderWorkspace, 'connectionId' | 'executionHostId'>
  ) =>
    scope.executionHostId ??
    (scope.connectionId ? toSshExecutionHostId(scope.connectionId) : 'local')
  const removeFolderWorkspace = vi.fn(
    (
      workspaceId: string,
      options: { executionHostId?: ExecutionHostId; preserveRendererWorkspaceKey?: boolean } = {}
    ) => {
      const matches = workspaces.filter(
        (workspace) =>
          workspace.id === workspaceId &&
          (!options.executionHostId ||
            (workspace.executionHostId ??
              (workspace.connectionId ? toSshExecutionHostId(workspace.connectionId) : 'local')) ===
              options.executionHostId)
      )
      if (matches.length !== 1) {
        return false
      }
      const removed = matches[0]!
      workspaces = workspaces.filter((workspace) => workspace !== removed)
      return true
    }
  )
  const deleteProjectGroup = vi.fn(
    (groupId: string, options: { executionHostId?: ExecutionHostId } = {}) => {
      const groups = args.groups.filter(
        (group) =>
          group.id === groupId &&
          (!options.executionHostId || getHostId(group) === options.executionHostId)
      )
      if (groups.length !== 1) {
        return false
      }
      const ownerHostId = getHostId(groups[0]!)
      workspaces = workspaces.filter(
        (workspace) => workspace.projectGroupId !== groupId || getHostId(workspace) !== ownerHostId
      )
      return true
    }
  )
  const localListProcesses = vi.fn(async () => [])
  const sshListProcesses = vi.fn(async () => [])
  const localProvider = {
    listProcesses: localListProcesses,
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
  const sshProvider = {
    listProcesses: sshListProcesses,
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
  const runtime = new OrcaRuntimeService(
    {
      getRepos: () => args.repos ?? [],
      getProjectGroups: () => args.groups,
      getFolderWorkspaces: () => workspaces,
      removeFolderWorkspace,
      deleteProjectGroup,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => ({}),
      removeWorktreeMeta: () => false,
      getSettings: () => ({})
    } as never,
    undefined,
    {
      getLocalProvider: () => localProvider,
      getSshProvider: () => sshProvider
    }
  )
  return {
    runtime,
    deleteProjectGroup,
    removeFolderWorkspace,
    workspaces: () => workspaces,
    localListProcesses,
    sshListProcesses
  }
}

function makeRepo(id: string, projectGroupId: string, connectionId: string | null): Repo {
  return {
    id,
    path: `/workspace/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    projectGroupId,
    connectionId
  }
}

function makeMobileSnapshot(
  worktree: string,
  snapshotVersion = 1
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:same-id-deletion',
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
        title: 'Terminal',
        isActive: true
      }
    ]
  }
}

describe('same-id folder workspace deletion', () => {
  it('preserves a paired-runtime graph while deleting the local owner', async () => {
    const workspace = makeWorkspace('shared-workspace')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const localPtyId = `${workspaceKey}@@local-pty`
    const remotePtyId = 'remote:env-sibling@@term_sibling'
    const runtime = createRuntime(workspace)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      if (ptyId === localPtyId) {
        runtime.onPtyExit(ptyId, 0)
      }
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const sync = (includeLocal: boolean, snapshotVersion: number): void => {
      const ptys = includeLocal
        ? [
            { tabId: 'local-tab', leafId: 'local-leaf', ptyId: localPtyId },
            { tabId: 'remote-tab', leafId: 'remote-leaf', ptyId: remotePtyId }
          ]
        : [{ tabId: 'remote-tab', leafId: 'remote-leaf', ptyId: remotePtyId }]
      const snapshot = makeMobileSnapshot(workspaceKey, snapshotVersion)
      const terminalTab = snapshot.tabs[0]!
      snapshot.tabs = ptys.map(({ tabId, leafId, ptyId }) => ({
        ...terminalTab,
        type: 'terminal',
        id: `${tabId}::${leafId}`,
        parentTabId: tabId,
        leafId,
        ptyId,
        title: tabId
      }))
      snapshot.activeTabId = snapshot.tabs[0]?.id ?? null
      runtime.syncWindowGraph(1, {
        tabs: ptys.map(({ tabId, leafId }) => ({
          tabId,
          worktreeId: workspaceKey,
          title: tabId,
          activeLeafId: leafId,
          layout: null
        })),
        leaves: ptys.map(({ tabId, leafId, ptyId }, index) => ({
          tabId,
          worktreeId: workspaceKey,
          leafId,
          paneRuntimeId: index + 1,
          ptyId
        })),
        mobileSessionTabs: [snapshot]
      })
    }
    runtime.attachWindow(1)
    sync(true, 1)

    await expect(
      runtime.deleteFolderWorkspace(workspace.id, { preserveRendererWorkspaceKey: true })
    ).resolves.toEqual({ deleted: true })

    const internals = runtime as unknown as {
      rendererDeletedFolderWorkspaceKeys: Set<string>
      rendererDeletedFolderWorkspacePtyIds: Map<string, Set<string>>
      tabs: Map<string, { worktreeId: string }>
      leaves: Map<string, { worktreeId: string; ptyId: string | null }>
      ptysById: Map<string, { worktreeId: string }>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    expect(stopAndWait).toHaveBeenCalledWith(localPtyId, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith(remotePtyId, expect.anything())
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([remotePtyId])
    expect(internals.ptysById.has(localPtyId)).toBe(false)
    expect(internals.ptysById.get(remotePtyId)).toEqual(
      expect.objectContaining({ worktreeId: workspaceKey })
    )
    expect(
      internals.mobileSessionTabsByWorktree
        .get(workspaceKey)
        ?.tabs.filter((tab) => tab.type === 'terminal')
        .map((tab) => tab.ptyId)
    ).toEqual([remotePtyId])
    expect(internals.rendererDeletedFolderWorkspaceKeys.has(workspaceKey)).toBe(false)
    expect(internals.rendererDeletedFolderWorkspacePtyIds.get(workspaceKey)).toEqual(
      new Set([localPtyId])
    )

    sync(true, 2)
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([remotePtyId])
    expect(internals.ptysById.has(localPtyId)).toBe(false)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(workspaceKey)
        ?.tabs.filter((tab) => tab.type === 'terminal')
        .map((tab) => tab.ptyId)
    ).toEqual([remotePtyId])
    expect(internals.rendererDeletedFolderWorkspacePtyIds.has(workspaceKey)).toBe(true)

    sync(false, 3)
    expect([...internals.tabs.values()].map((tab) => tab.worktreeId)).toEqual([workspaceKey])
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([remotePtyId])
    expect(internals.rendererDeletedFolderWorkspacePtyIds.has(workspaceKey)).toBe(false)
  })

  it('fences a snapshot-only owner PTY and preserves the surviving split layout', async () => {
    const workspace = makeWorkspace('snapshot-shared')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const localPtyId = `${workspaceKey}@@snapshot-only`
    const remotePtyIds = ['remote:env-sibling@@remote-a', 'remote:env-sibling@@remote-b']
    const leafIds = ['local', 'remote-a', 'remote-b']
    const survivingLayoutRoot: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.4,
      first: { type: 'leaf', leafId: leafIds[1]! },
      second: { type: 'leaf', leafId: leafIds[2]! }
    }
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.25,
        first: { type: 'leaf', leafId: leafIds[0]! },
        second: survivingLayoutRoot
      },
      activeLeafId: leafIds[0]!,
      expandedLeafId: leafIds[0]!,
      ptyIdsByLeafId: {
        [leafIds[0]!]: localPtyId,
        [leafIds[1]!]: remotePtyIds[0]!,
        [leafIds[2]!]: remotePtyIds[1]!
      },
      buffersByLeafId: { local: 'local-buffer', 'remote-a': 'a-buffer' },
      scrollbackRefsByLeafId: { local: 'local-ref', 'remote-b': 'b-ref' },
      titlesByLeafId: { local: 'Local', 'remote-a': 'Remote A', 'remote-b': 'Remote B' }
    }
    const runtime = createRuntime(workspace)
    runtime.preAllocateHandleForPty(localPtyId)
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const snapshot = makeMobileSnapshot(workspaceKey)
    snapshot.tabs = [localPtyId, ...remotePtyIds].map((ptyId, index) => ({
      type: 'terminal',
      id: `shared::${leafIds[index]}`,
      parentTabId: 'shared',
      leafId: leafIds[index]!,
      ptyId,
      title: leafIds[index]!,
      parentLayout: layout,
      isActive: index === 0
    }))
    snapshot.activeTabId = snapshot.tabs[0]!.id
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'shared',
          worktreeId: workspaceKey,
          title: 'shared',
          activeLeafId: leafIds[1]!,
          layout: survivingLayoutRoot
        }
      ],
      leaves: remotePtyIds.map((ptyId, index) => ({
        tabId: 'shared',
        worktreeId: workspaceKey,
        leafId: leafIds[index + 1]!,
        paneRuntimeId: index + 1,
        ptyId
      })),
      mobileSessionTabs: [snapshot]
    })

    await expect(runtime.deleteFolderWorkspace(workspace.id)).resolves.toEqual({ deleted: true })

    const internals = runtime as unknown as {
      rendererDeletedFolderWorkspacePtyIds: Map<string, Set<string>>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      handleByPtyId: Map<string, string>
    }
    const stored = internals.mobileSessionTabsByWorktree.get(workspaceKey)!
    const expectedLayout: TerminalLayoutSnapshot = {
      root: survivingLayoutRoot,
      activeLeafId: leafIds[1]!,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'remote-a': remotePtyIds[0]!, 'remote-b': remotePtyIds[1]! },
      buffersByLeafId: { 'remote-a': 'a-buffer' },
      scrollbackRefsByLeafId: { 'remote-b': 'b-ref' },
      titlesByLeafId: { 'remote-a': 'Remote A', 'remote-b': 'Remote B' }
    }
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.rendererDeletedFolderWorkspacePtyIds.get(workspaceKey)).toEqual(
      new Set([localPtyId])
    )
    expect(internals.handleByPtyId.has(localPtyId)).toBe(false)
    expect(stored).toMatchObject({ activeTabId: 'shared::remote-a', activeTabType: 'terminal' })
    expect(stored.tabs.map((tab) => tab.id)).toEqual(['shared::remote-a', 'shared::remote-b'])
    expect(stored.tabs.map((tab) => tab.isActive)).toEqual([true, false])
    expect(stored.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentLayout : null))).toEqual([
      expectedLayout,
      expectedLayout
    ])
  })

  it('deletes only the requested direct-SSH owner when local IDs and group IDs collide', async () => {
    const workspaceId = 'local-ssh-shared'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const sshConnectionId = 'ssh-owner'
    const sshHostId = toSshExecutionHostId(sshConnectionId)
    const localWorkspace = makeWorkspace(workspaceId)
    const sshWorkspace = {
      ...makeWorkspace(workspaceId),
      connectionId: sshConnectionId
    }
    const fixture = createHostQualifiedRuntime({
      groups: [makeGroup(), { ...makeGroup(), connectionId: sshConnectionId }],
      workspaces: [localWorkspace, sshWorkspace],
      repos: [
        makeRepo('local-collision-repo', GROUP_ID, null),
        makeRepo('ssh-collision-repo', GROUP_ID, sshConnectionId)
      ]
    })
    const localPtyId = `${workspaceKey}@@local`
    const sshPtyId = `ssh:${sshConnectionId}@@owner`
    const stopAndWait = vi.fn(async (ptyId: string) => {
      fixture.runtime.onPtyExit(ptyId, 0)
      return true
    })
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    fixture.runtime.attachWindow(1)
    fixture.runtime.syncWindowGraph(1, {
      tabs: [localPtyId, sshPtyId].map((_, index) => ({
        tabId: `tab-${index}`,
        worktreeId: workspaceKey,
        title: 'shell',
        activeLeafId: `leaf-${index}`,
        layout: null
      })),
      leaves: [localPtyId, sshPtyId].map((ptyId, index) => ({
        tabId: `tab-${index}`,
        worktreeId: workspaceKey,
        leafId: `leaf-${index}`,
        paneRuntimeId: index + 1,
        ptyId
      }))
    })

    await expect(fixture.runtime.deleteFolderWorkspace(workspaceId)).resolves.toEqual({
      deleted: false
    })
    await expect(
      fixture.runtime.deleteFolderWorkspace(workspaceId, { executionHostId: sshHostId })
    ).resolves.toEqual({ deleted: true })

    expect(fixture.removeFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(fixture.removeFolderWorkspace).toHaveBeenCalledWith(workspaceId, {
      executionHostId: sshHostId,
      preserveRendererWorkspaceKey: true
    })
    expect(fixture.workspaces()).toEqual([localWorkspace])
    expect(stopAndWait).toHaveBeenCalledWith(sshPtyId, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith(localPtyId, expect.anything())
    const internals = fixture.runtime as unknown as {
      leaves: Map<string, { ptyId: string | null }>
    }
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([localPtyId])
  })

  it('preserves foreign PTYs and shared runtime state without an attached window', async () => {
    const workspace = makeWorkspace('windowless-shared')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const localPtyId = `${workspaceKey}@@local-owner`
    const remotePtyId = 'remote:paired-owner@@survivor'
    const fixture = createHostQualifiedRuntime({
      groups: [makeGroup()],
      workspaces: [workspace]
    })
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const remoteHandle = fixture.runtime.preAllocateHandleForPty(remotePtyId)
    fixture.runtime.registerPty(localPtyId, workspaceKey, null)
    fixture.runtime.registerPty(remotePtyId, workspaceKey, null)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      fixture.runtime.onPtyExit(ptyId, 0)
      return true
    })
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const internals = fixture.runtime as unknown as {
      ptysById: Map<string, unknown>
      handleByPtyId: Map<string, string>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const snapshot = makeMobileSnapshot(workspaceKey)
    internals.mobileSessionTabsByWorktree.set(workspaceKey, snapshot)

    await expect(
      fixture.runtime.deleteFolderWorkspace(workspace.id, { executionHostId: 'local' })
    ).resolves.toEqual({ deleted: true })

    expect(fixture.removeFolderWorkspace).toHaveBeenCalledWith(workspace.id, {
      executionHostId: 'local',
      preserveRendererWorkspaceKey: true
    })
    expect(stopAndWait).toHaveBeenCalledWith(localPtyId, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith(remotePtyId, expect.anything())
    expect(internals.ptysById.has(localPtyId)).toBe(false)
    expect(internals.ptysById.has(remotePtyId)).toBe(true)
    expect(internals.handleByPtyId.get(remotePtyId)).toBe(remoteHandle)
    expect(internals.mobileSessionTabsByWorktree.get(workspaceKey)).toBe(snapshot)
  })

  it('preserves catalog-sibling runtime state during windowless folder deletion', async () => {
    const workspaceId = 'windowless-catalog-folder'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const connectionId = 'ssh-catalog-folder'
    const sshHostId = toSshExecutionHostId(connectionId)
    const localWorkspace = makeWorkspace(workspaceId)
    const sshWorkspace = { ...makeWorkspace(workspaceId), connectionId }
    const fixture = createHostQualifiedRuntime({
      groups: [makeGroup(), { ...makeGroup(), connectionId }],
      workspaces: [localWorkspace, sshWorkspace]
    })
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const localPtyId = `${workspaceKey}@@catalog-survivor`
    const sshPtyId = `ssh:${connectionId}@@catalog-owner`
    const localHandle = fixture.runtime.preAllocateHandleForPty(localPtyId)
    fixture.runtime.registerPty(localPtyId, workspaceKey, null)
    fixture.runtime.registerPty(sshPtyId, workspaceKey, connectionId)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      fixture.runtime.onPtyExit(ptyId, 0)
      return true
    })
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const internals = fixture.runtime as unknown as {
      ptysById: Map<string, unknown>
      handleByPtyId: Map<string, string>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const snapshot = makeMobileSnapshot(workspaceKey)
    internals.mobileSessionTabsByWorktree.set(workspaceKey, snapshot)

    await expect(
      fixture.runtime.deleteFolderWorkspace(workspaceId, { executionHostId: sshHostId })
    ).resolves.toEqual({ deleted: true })

    expect(fixture.removeFolderWorkspace).toHaveBeenCalledWith(workspaceId, {
      executionHostId: sshHostId,
      preserveRendererWorkspaceKey: true
    })
    expect(fixture.workspaces()).toEqual([localWorkspace])
    expect(stopAndWait).toHaveBeenCalledWith(sshPtyId, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith(localPtyId, expect.anything())
    expect(internals.ptysById.has(sshPtyId)).toBe(false)
    expect(internals.ptysById.has(localPtyId)).toBe(true)
    expect(internals.handleByPtyId.get(localPtyId)).toBe(localHandle)
    expect(internals.mobileSessionTabsByWorktree.get(workspaceKey)).toBe(snapshot)
  })

  it('preserves catalog-sibling runtime state during windowless group deletion', async () => {
    const workspaceId = 'windowless-catalog-group'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const connectionId = 'ssh-catalog-group'
    const sshHostId = toSshExecutionHostId(connectionId)
    const localWorkspace = makeWorkspace(workspaceId)
    const sshWorkspace = { ...makeWorkspace(workspaceId), connectionId }
    const fixture = createHostQualifiedRuntime({
      groups: [makeGroup(), { ...makeGroup(), connectionId }],
      workspaces: [localWorkspace, sshWorkspace]
    })
    const internals = fixture.runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const snapshot = makeMobileSnapshot(workspaceKey)
    internals.mobileSessionTabsByWorktree.set(workspaceKey, snapshot)

    await expect(
      fixture.runtime.deleteProjectGroup(GROUP_ID, { executionHostId: sshHostId })
    ).resolves.toEqual({ deleted: true })

    expect(fixture.deleteProjectGroup).toHaveBeenCalledWith(GROUP_ID, {
      executionHostId: sshHostId,
      preserveRendererWorkspaceIds: [workspaceId]
    })
    expect(fixture.workspaces()).toEqual([localWorkspace])
    expect(internals.mobileSessionTabsByWorktree.get(workspaceKey)).toBe(snapshot)
  })

  it('rejects a queued SSH spawn lease when only a same-ID local sibling survives', async () => {
    const workspaceId = 'queued-owner-revalidation'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const connectionId = 'ssh-queued-owner'
    const sshHostId = toSshExecutionHostId(connectionId)
    const sshWorkspace = { ...makeWorkspace(workspaceId), connectionId }
    const localWorkspace = makeWorkspace(workspaceId)
    const fixture = createHostQualifiedRuntime({
      groups: [{ ...makeGroup(), connectionId }, makeGroup()],
      workspaces: [sshWorkspace, localWorkspace]
    })
    const internals = fixture.runtime as unknown as {
      terminalMutationTailByWorktreeId: Map<string, Promise<void>>
    }
    const releaseBlocker = await fixture.runtime.acquireWorktreeTerminalSpawn(workspaceKey)
    try {
      const blockerTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
      const deletion = fixture.runtime.deleteFolderWorkspace(workspaceId, {
        executionHostId: sshHostId
      })
      await vi.waitFor(() =>
        expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(blockerTail)
      )
      const deletionTail = internals.terminalMutationTailByWorktreeId.get(workspaceKey)
      const spawnLease = fixture.runtime.acquireWorktreeTerminalSpawn(workspaceKey, {
        executionHostId: sshHostId,
        connectionId
      })
      void spawnLease.then(
        (release) => release(),
        () => undefined
      )
      await vi.waitFor(() =>
        expect(internals.terminalMutationTailByWorktreeId.get(workspaceKey)).not.toBe(deletionTail)
      )

      releaseBlocker()

      await expect(deletion).resolves.toEqual({ deleted: true })
      await expect(spawnLease).rejects.toThrow('folder_workspace_not_found')
      expect(fixture.workspaces()).toEqual([localWorkspace])
    } finally {
      releaseBlocker()
    }
  })

  it('leaves every mixed-host PTY intact when folder ownership is ambiguous', async () => {
    const workspace = { ...makeWorkspace('mixed-owner'), connectionId: undefined as never }
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const fixture = createHostQualifiedRuntime({
      groups: [{ ...makeGroup(), connectionId: undefined as never }],
      workspaces: [workspace],
      repos: [makeRepo('local-repo', GROUP_ID, null), makeRepo('ssh-repo', GROUP_ID, 'ssh-1')]
    })
    const ptyIds = [`${workspaceKey}@@local`, 'ssh:ssh-1@@remote']
    const stopAndWait = vi.fn().mockResolvedValue(true)
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    fixture.runtime.attachWindow(1)
    fixture.runtime.syncWindowGraph(1, {
      tabs: ptyIds.map((_, index) => ({
        tabId: `mixed-tab-${index}`,
        worktreeId: workspaceKey,
        title: 'shell',
        activeLeafId: `mixed-leaf-${index}`,
        layout: null
      })),
      leaves: ptyIds.map((ptyId, index) => ({
        tabId: `mixed-tab-${index}`,
        worktreeId: workspaceKey,
        leafId: `mixed-leaf-${index}`,
        paneRuntimeId: index + 1,
        ptyId
      }))
    })

    await expect(
      fixture.runtime.deleteFolderWorkspace(workspace.id, { executionHostId: 'local' })
    ).resolves.toEqual({ deleted: true })

    expect(fixture.removeFolderWorkspace).toHaveBeenCalledWith(workspace.id, {
      executionHostId: 'local',
      preserveRendererWorkspaceKey: true
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(fixture.localListProcesses).not.toHaveBeenCalled()
    expect(fixture.sshListProcesses).not.toHaveBeenCalled()
    const internals = fixture.runtime as unknown as {
      leaves: Map<string, { ptyId: string | null }>
      ptysById: Map<string, unknown>
    }
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual(ptyIds)
    expect([...internals.ptysById.keys()]).toEqual(ptyIds)
  })

  it('keeps ambiguous PTYs intact during host-qualified project-group deletion', async () => {
    const workspace = {
      ...makeWorkspace('mixed-group-owner'),
      connectionId: undefined as never
    }
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const fixture = createHostQualifiedRuntime({
      groups: [{ ...makeGroup(), connectionId: undefined as never }],
      workspaces: [workspace],
      repos: [
        makeRepo('local-group-repo', GROUP_ID, null),
        makeRepo('ssh-group-repo', GROUP_ID, 'ssh-1')
      ]
    })
    const ptyIds = [`${workspaceKey}@@local`, 'ssh:ssh-1@@remote']
    const stopAndWait = vi.fn().mockResolvedValue(true)
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    fixture.runtime.attachWindow(1)
    fixture.runtime.syncWindowGraph(1, {
      tabs: ptyIds.map((_, index) => ({
        tabId: `mixed-group-tab-${index}`,
        worktreeId: workspaceKey,
        title: 'shell',
        activeLeafId: `mixed-group-leaf-${index}`,
        layout: null
      })),
      leaves: ptyIds.map((ptyId, index) => ({
        tabId: `mixed-group-tab-${index}`,
        worktreeId: workspaceKey,
        leafId: `mixed-group-leaf-${index}`,
        paneRuntimeId: index + 1,
        ptyId
      }))
    })

    await expect(
      fixture.runtime.deleteProjectGroup(GROUP_ID, { executionHostId: 'local' })
    ).resolves.toEqual({ deleted: true })

    expect(fixture.deleteProjectGroup).toHaveBeenCalledWith(GROUP_ID, {
      executionHostId: 'local',
      preserveRendererWorkspaceIds: [workspace.id]
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(fixture.localListProcesses).not.toHaveBeenCalled()
    expect(fixture.sshListProcesses).not.toHaveBeenCalled()
    const internals = fixture.runtime as unknown as {
      leaves: Map<string, { ptyId: string | null }>
      ptysById: Map<string, unknown>
    }
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual(ptyIds)
    expect([...internals.ptysById.keys()]).toEqual(ptyIds)
  })
})
