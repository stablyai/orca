import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../shared/types'
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

const GROUP_ID = 'strict-group'

function makeGroup(connectionId: string | null | undefined): ProjectGroup {
  return {
    id: GROUP_ID,
    name: 'Strict group',
    parentPath: '/workspace',
    ...(connectionId === undefined ? {} : { connectionId }),
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorkspace(id: string, connectionId: string | null | undefined): FolderWorkspace {
  return {
    id,
    projectGroupId: GROUP_ID,
    name: id,
    folderPath: `/workspace/${id}`,
    ...(connectionId === undefined ? {} : { connectionId }),
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

function makeProvider(initialRows: ProcessRow[] = []) {
  let rows = [...initialRows]
  const listProcesses = vi.fn(async () => [...rows])
  const shutdown = vi.fn(async (ptyId: string) => {
    rows = rows.filter((row) => row.id !== ptyId)
  })
  return {
    provider: { listProcesses, shutdown } as unknown as IPtyProvider,
    listProcesses,
    shutdown
  }
}

function processRow(workspace: FolderWorkspace): ProcessRow {
  const workspaceKey = folderWorkspaceKey(workspace.id)
  return {
    id: `${workspaceKey}@@shell`,
    worktreeId: workspaceKey,
    cwd: workspace.folderPath,
    title: 'shell'
  }
}

function makeRepo(
  id: string,
  path: string,
  connectionId: string | null,
  projectGroupId = GROUP_ID
): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    projectGroupId,
    connectionId
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createFixture(args: {
  groups: ProjectGroup[]
  workspaces: FolderWorkspace[]
  localProvider: IPtyProvider
  getSshProvider: (connectionId: string) => IPtyProvider | undefined
  repos?: Repo[]
  events?: string[]
}) {
  let groups = [...args.groups]
  let workspaces = [...args.workspaces]
  const removeFolderWorkspace = vi.fn((workspaceId: string) => {
    const before = workspaces.length
    workspaces = workspaces.filter((workspace) => workspace.id !== workspaceId)
    if (workspaces.length === before) {
      return false
    }
    args.events?.push(`metadata:${workspaceId}`)
    return true
  })
  const deleteProjectGroup = vi.fn((groupId: string) => {
    if (!groups.some((group) => group.id === groupId)) {
      return false
    }
    const deletedGroupIds = getProjectGroupSubtreeIds(groups, groupId)
    groups = groups.filter((group) => !deletedGroupIds.has(group.id))
    workspaces = workspaces.filter((workspace) => !deletedGroupIds.has(workspace.projectGroupId))
    args.events?.push(`metadata-group:${groupId}`)
    return true
  })
  const store = {
    getRepos: () => args.repos ?? [],
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => workspaces,
    removeFolderWorkspace,
    deleteProjectGroup,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => ({}),
    removeWorktreeMeta: () => false,
    getSettings: () => ({})
  } as unknown as NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[0]>
  const runtime = new OrcaRuntimeService(store, undefined, {
    getLocalProvider: () => args.localProvider,
    getSshProvider: args.getSshProvider
  })
  return {
    runtime,
    groups: () => groups,
    workspaces: () => workspaces,
    removeFolderWorkspace,
    deleteProjectGroup
  }
}

function syncGraphPty(runtime: OrcaRuntimeService, workspaceKey: string, ptyId: string): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'strict-tab',
        worktreeId: workspaceKey,
        title: 'shell',
        activeLeafId: 'strict-leaf',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'strict-tab',
        worktreeId: workspaceKey,
        leafId: 'strict-leaf',
        paneRuntimeId: 1,
        ptyId
      }
    ]
  })
}

beforeEach(() => {
  deleteWorktreeHistoryDirMock.mockReset()
  listRegisteredPtysMock.mockReset()
  listRegisteredPtysMock.mockReturnValue([])
})

describe('strict direct-SSH folder workspace deletion', () => {
  it('fails before catalog or runtime mutation when the provider is absent', async () => {
    const workspace = makeWorkspace('missing-provider', 'ssh-1')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const ptyId = 'ssh:ssh-1@@live-shell'
    const localProvider = makeProvider([processRow(workspace)])
    const fixture = createFixture({
      groups: [makeGroup('ssh-1')],
      workspaces: [workspace],
      localProvider: localProvider.provider,
      getSshProvider: () => undefined
    })
    const stopAndWait = vi.fn().mockResolvedValue(true)
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncGraphPty(fixture.runtime, workspaceKey, ptyId)
    const mobileMarker = {}
    const internals = fixture.runtime as unknown as {
      tabs: Map<string, unknown>
      ptysById: Map<string, { connected: boolean }>
      mobileSessionTabsByWorktree: Map<string, unknown>
      rendererPendingFolderWorkspaceDeletionKeys: Set<string>
    }
    internals.mobileSessionTabsByWorktree.set(workspaceKey, mobileMarker)

    await expect(fixture.runtime.deleteFolderWorkspace(workspace.id)).rejects.toThrow(
      'PTY provider unavailable for folder workspace deletion'
    )

    expect(fixture.workspaces()).toEqual([workspace])
    expect(fixture.removeFolderWorkspace).not.toHaveBeenCalled()
    expect([...internals.tabs.keys()]).toEqual(['strict-tab'])
    expect(internals.ptysById.get(ptyId)?.connected).toBe(true)
    expect(internals.mobileSessionTabsByWorktree.get(workspaceKey)).toBe(mobileMarker)
    expect(internals.rendererPendingFolderWorkspaceDeletionKeys.size).toBe(0)
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('preflights every provider before mutating a mixed local and SSH group', async () => {
    const group = makeGroup(undefined)
    const localGroup = {
      ...makeGroup(undefined),
      id: 'local-child',
      parentGroupId: GROUP_ID
    }
    const sshGroup = {
      ...makeGroup(undefined),
      id: 'ssh-child',
      parentGroupId: GROUP_ID
    }
    const localWorkspace = {
      ...makeWorkspace('local', undefined),
      projectGroupId: localGroup.id
    }
    const sshWorkspace = {
      ...makeWorkspace('ssh', undefined),
      projectGroupId: sshGroup.id
    }
    const localProvider = makeProvider([processRow(localWorkspace)])
    let sshProvider: IPtyProvider | undefined
    const fixture = createFixture({
      groups: [group, localGroup, sshGroup],
      workspaces: [localWorkspace, sshWorkspace],
      repos: [
        makeRepo('local-repo', `${localWorkspace.folderPath}/repo`, null, localGroup.id),
        makeRepo('ssh-repo', `${sshWorkspace.folderPath}/repo`, 'ssh-1', sshGroup.id)
      ],
      localProvider: localProvider.provider,
      getSshProvider: () => sshProvider
    })

    await expect(fixture.runtime.deleteProjectGroup(GROUP_ID)).rejects.toThrow(
      'PTY provider unavailable for folder workspace deletion'
    )

    expect(fixture.groups()).toEqual([group, localGroup, sshGroup])
    expect(fixture.workspaces()).toEqual([localWorkspace, sshWorkspace])
    expect(fixture.deleteProjectGroup).not.toHaveBeenCalled()
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()

    const reconnectedProvider = makeProvider([processRow(sshWorkspace)])
    sshProvider = reconnectedProvider.provider
    await expect(fixture.runtime.deleteProjectGroup(GROUP_ID)).resolves.toEqual({ deleted: true })
    expect(reconnectedProvider.shutdown).toHaveBeenCalledTimes(1)
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
  })

  it('freezes stale graphs and queued spawns until a failed exact stop unwinds', async () => {
    const workspace = makeWorkspace('pending-fence', 'ssh-1')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const livePtyId = 'ssh:ssh-1@@live-shell'
    const inventoryStarted = deferred<void>()
    const finishInventory = deferred<void>()
    const provider = {
      listProcesses: vi.fn(async () => {
        inventoryStarted.resolve()
        await finishInventory.promise
        return []
      }),
      shutdown: vi.fn()
    } as unknown as IPtyProvider
    let availableProvider: IPtyProvider | undefined = provider
    const fixture = createFixture({
      groups: [makeGroup('ssh-1')],
      workspaces: [workspace],
      localProvider: makeProvider().provider,
      getSshProvider: () => availableProvider
    })
    const stopStarted = deferred<void>()
    const finishStop = deferred<void>()
    fixture.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait: vi.fn(async () => {
        availableProvider = undefined
        stopStarted.resolve()
        await finishStop.promise
        return false
      }),
      getForegroundProcess: async () => null
    })
    syncGraphPty(fixture.runtime, workspaceKey, livePtyId)
    const mobileMarker = {}
    const internals = fixture.runtime as unknown as {
      tabs: Map<string, { tabId: string }>
      ptysById: Map<string, unknown>
      mobileSessionTabsByWorktree: Map<string, unknown>
      rendererPendingFolderWorkspaceDeletionKeys: Set<string>
    }
    internals.mobileSessionTabsByWorktree.set(workspaceKey, mobileMarker)

    const deletion = fixture.runtime.deleteFolderWorkspace(workspace.id)
    void deletion.catch(() => undefined)
    await inventoryStarted.promise
    fixture.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'stale-tab',
          worktreeId: workspaceKey,
          title: 'stale',
          activeLeafId: 'stale-leaf',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'stale-tab',
          worktreeId: workspaceKey,
          leafId: 'stale-leaf',
          paneRuntimeId: 2,
          ptyId: 'ssh:ssh-1@@stale-shell'
        }
      ]
    })
    let spawnLeaseAcquired = false
    const spawnLease = fixture.runtime
      .acquireWorktreeTerminalSpawn(workspaceKey)
      .then((release) => {
        spawnLeaseAcquired = true
        return release
      })
    await Promise.resolve()
    expect(spawnLeaseAcquired).toBe(false)

    finishInventory.resolve()
    await stopStarted.promise
    finishStop.resolve()
    await expect(deletion).rejects.toThrow('Unable to verify PTY stopped')
    const releaseSpawn = await spawnLease
    releaseSpawn()

    expect([...internals.tabs.keys()]).toEqual(['strict-tab'])
    expect([...internals.ptysById.keys()]).toEqual([livePtyId])
    expect(internals.mobileSessionTabsByWorktree.get(workspaceKey)).toBe(mobileMarker)
    expect(internals.rendererPendingFolderWorkspaceDeletionKeys.size).toBe(0)
    expect(fixture.workspaces()).toEqual([workspace])
    expect(fixture.removeFolderWorkspace).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('propagates a provider that vanishes after preflight without purging', async () => {
    const workspace = makeWorkspace('vanishing-provider', 'ssh-1')
    const provider = makeProvider()
    const getSshProvider = vi
      .fn<(connectionId: string) => IPtyProvider | undefined>()
      .mockReturnValueOnce(provider.provider)
      .mockReturnValue(undefined)
    const fixture = createFixture({
      groups: [makeGroup('ssh-1')],
      workspaces: [workspace],
      localProvider: makeProvider().provider,
      getSshProvider
    })

    await expect(fixture.runtime.deleteFolderWorkspace(workspace.id)).rejects.toThrow(
      'PTY provider unavailable for folder workspace deletion'
    )

    expect(getSshProvider).toHaveBeenCalledTimes(2)
    expect(fixture.workspaces()).toEqual([workspace])
    expect(fixture.removeFolderWorkspace).not.toHaveBeenCalled()
    expect(provider.listProcesses).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('propagates provider inventory failure without committing metadata', async () => {
    const workspace = makeWorkspace('failing-provider', 'ssh-1')
    const listProcesses = vi.fn().mockRejectedValue(new Error('relay disconnected'))
    const provider = {
      listProcesses,
      shutdown: vi.fn()
    } as unknown as IPtyProvider
    const fixture = createFixture({
      groups: [makeGroup('ssh-1')],
      workspaces: [workspace],
      localProvider: makeProvider().provider,
      getSshProvider: () => provider
    })

    await expect(fixture.runtime.deleteFolderWorkspace(workspace.id)).rejects.toThrow(
      'relay disconnected'
    )

    expect(fixture.workspaces()).toEqual([workspace])
    expect(fixture.removeFolderWorkspace).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('commits a direct-SSH group only after every remote PTY stops', async () => {
    const first = makeWorkspace('ssh-first', 'ssh-1')
    const second = makeWorkspace('ssh-second', 'ssh-1')
    const events: string[] = []
    const provider = makeProvider([processRow(first), processRow(second)])
    provider.shutdown.mockImplementation(async (ptyId: string) => {
      events.push(`stop:${ptyId}`)
    })
    const fixture = createFixture({
      groups: [makeGroup('ssh-1')],
      workspaces: [first, second],
      localProvider: makeProvider().provider,
      getSshProvider: () => provider.provider,
      events
    })

    await expect(fixture.runtime.deleteProjectGroup(GROUP_ID)).resolves.toEqual({ deleted: true })

    expect(provider.shutdown).toHaveBeenCalledTimes(2)
    expect(fixture.groups()).toEqual([])
    expect(fixture.workspaces()).toEqual([])
    expect(events.at(-1)).toBe(`metadata-group:${GROUP_ID}`)
  })
})
