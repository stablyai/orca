import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { FolderWorkspace, ProjectGroup, Repo, WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
    BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
    ipcMain,
    Notification: vi.fn(),
    webContents: { fromId: vi.fn(() => null) }
  }
})

vi.mock('electron', () => electronMocks)

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const INCARNATION_ID = '33333333-3333-4333-8333-333333333333'

function makeSession(worktreeId: string, ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: worktreeId,
    activeTabId: TAB_ID,
    activeTabIdByWorktree: { [worktreeId]: TAB_ID },
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId,
          title: 'Persisted terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: INCARNATION_ID
    }
  }
}

function makeFolder(
  id: string,
  projectGroupId: string,
  executionHostId: ExecutionHostId | null = null
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId: null,
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeGroup(id: string, executionHostId: ExecutionHostId | null = null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/workspace/${id}`,
    connectionId: null,
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function createRuntime(args: {
  folders?: FolderWorkspace[]
  groups?: ProjectGroup[]
  repos?: Repo[]
  worktreeHosts?: Record<string, ExecutionHostId>
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
}): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getRepo: (id: string) => args.repos?.find((repo) => repo.id === id),
    getRepos: () => args.repos ?? [],
    getFolderWorkspaces: () => args.folders ?? [],
    getProjectGroups: () => args.groups ?? [],
    getWorkspaceSession: (hostId?: string | null) =>
      args.sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
    getWorkspaceSessionHostIds: () => [...args.sessions.keys()],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () =>
      Object.fromEntries(
        Object.entries(args.worktreeHosts ?? {}).map(([worktreeId, hostId]) => [
          worktreeId,
          { hostId }
        ])
      ),
    getWorktreeMeta: (worktreeId: string) => {
      const hostId = args.worktreeHosts?.[worktreeId]
      return hostId ? { hostId } : undefined
    },
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/workspace',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  } as never)
}

describe('mobile folder stale state', () => {
  it.each(['workspace', 'project group'] as const)(
    'rejects a stale non-owner partition when the %s declares the folder host',
    async (ownerSource) => {
      const ownerHostId = toRuntimeExecutionHostId(`${ownerSource.replace(' ', '-')}-owner`)
      const folder = makeFolder(
        `moved-${ownerSource.replace(' ', '-')}`,
        `moved-${ownerSource.replace(' ', '-')}-group`,
        ownerSource === 'workspace' ? ownerHostId : null
      )
      const folderKey = `folder:${folder.id}`
      const runtime = createRuntime({
        folders: [folder],
        groups: [
          makeGroup(folder.projectGroupId, ownerSource === 'project group' ? ownerHostId : null)
        ],
        sessions: new Map([
          ['local', makeSession(folderKey, `${folderKey}@@stale-local`)],
          [ownerHostId, getDefaultWorkspaceSession()]
        ])
      })
      runtime.attachWindow(1)

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: []
      })

      await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
    }
  )

  it('skips a folder whose persisted host is no longer safely resolvable', async () => {
    const folder = makeFolder('ambiguous-folder', 'ambiguous-folder-group')
    const folderKey = `folder:${folder.id}`
    const localRepo: Repo = {
      id: 'ambiguous-folder-repo',
      path: folder.folderPath,
      displayName: 'Ambiguous folder repo',
      badgeColor: 'blue',
      projectGroupId: folder.projectGroupId,
      connectionId: null,
      addedAt: 1
    }
    const runtime = createRuntime({
      folders: [folder],
      groups: [makeGroup(folder.projectGroupId)],
      repos: [localRepo, { ...localRepo, connectionId: 'ambiguous-ssh' }],
      sessions: new Map([['local', makeSession(folderKey, `${folderKey}@@stale`)]])
    })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
    runtime.attachWindow(1)
    expect(() =>
      runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    ).not.toThrow()
  })

  it('does not rehydrate a deleted folder from stale aggregate persistence', async () => {
    const folder = makeFolder('deleted-folder', 'deleted-folder-group')
    const folderKey = `folder:${folder.id}`
    const folders = [folder]
    const runtime = createRuntime({
      folders,
      groups: [makeGroup(folder.projectGroupId)],
      sessions: new Map([['local', makeSession(folderKey, `${folderKey}@@stale-persisted`)]])
    })
    await expect(runtime.listAllMobileSessionTabs()).resolves.toHaveLength(1)

    folders.length = 0

    await expect(runtime.listAllMobileSessionTabs()).resolves.toMatchObject([
      { worktree: folderKey, removed: true, tabs: [] }
    ])
  })

  it('fences aggregate serialization when folder deletion races PTY inventory', async () => {
    const folder = makeFolder('inventory-race-folder', 'inventory-race-group')
    const folderKey = `folder:${folder.id}`
    const folders = [folder]
    const runtime = createRuntime({
      folders,
      groups: [makeGroup(folder.projectGroupId)],
      sessions: new Map([['local', makeSession(folderKey, `${folderKey}@@inventory-race`)]])
    })
    await runtime.listAllMobileSessionTabs()
    let releaseInventory!: (value: []) => void
    const inventory = new Promise<[]>((resolve) => {
      releaseInventory = resolve
    })
    const listProcesses = vi.fn(() => inventory)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const listing = runtime.listAllMobileSessionTabs()
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    folders.length = 0
    releaseInventory([])

    await expect(listing).resolves.toMatchObject([{ worktree: folderKey, removed: true, tabs: [] }])
  })

  it('serializes the latest persisted folder binding after PTY inventory', async () => {
    const folder = makeFolder('inventory-rebind-folder', 'inventory-rebind-group')
    const folderKey = `folder:${folder.id}`
    const oldPtyId = `${folderKey}@@old-inventory`
    const newPtyId = `${folderKey}@@new-inventory`
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      ['local', makeSession(folderKey, oldPtyId)]
    ])
    const runtime = createRuntime({
      folders: [folder],
      groups: [makeGroup(folder.projectGroupId)],
      sessions
    })
    let releaseInventory!: (value: []) => void
    const inventory = new Promise<[]>((resolve) => {
      releaseInventory = resolve
    })
    const listProcesses = vi.fn(() => inventory)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const listing = runtime.listAllMobileSessionTabs()
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    sessions.set('local', makeSession(folderKey, newPtyId))
    releaseInventory([])

    await expect(listing).resolves.toMatchObject([
      { worktree: folderKey, tabs: [{ ptyId: newPtyId }] }
    ])
  })

  it('rehydrates an omitted attached folder after its persisted PTY is rebound', async () => {
    const folder = makeFolder('rebound-folder', 'rebound-group')
    const folderKey = `folder:${folder.id}`
    const oldPtyId = `${folderKey}@@old`
    const newPtyId = `${folderKey}@@new`
    const session = makeSession(folderKey, oldPtyId)
    const runtime = createRuntime({
      folders: [folder],
      groups: [makeGroup(folder.projectGroupId)],
      sessions: new Map([['local', session]])
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    await expect(runtime.listMobileSessionTabs(`id:${folderKey}`)).resolves.toMatchObject({
      tabs: [{ ptyId: oldPtyId }]
    })
    session.tabsByWorktree[folderKey]![0]!.ptyId = newPtyId
    session.terminalLayoutsByTabId[TAB_ID]!.ptyIdsByLeafId = {
      [LEAF_ID]: newPtyId
    }

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const rebound = await runtime.listMobileSessionTabs(`id:${folderKey}`)
    const repeated = await runtime.listMobileSessionTabs(`id:${folderKey}`)

    expect(rebound).toMatchObject({ tabs: [{ ptyId: newPtyId }] })
    expect(repeated).toEqual(rebound)

    session.tabsByWorktree[folderKey]![0]!.customTitle = 'Renamed persisted terminal'

    await expect(runtime.listMobileSessionTabs(`id:${folderKey}`)).resolves.toMatchObject({
      tabs: [{ ptyId: newPtyId, title: 'Renamed persisted terminal' }]
    })

    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    session.tabsByWorktree = {}
    session.terminalLayoutsByTabId = {}
    await runtime.listMobileSessionTabs(`id:${folderKey}`)

    expect(events.at(-1)).toMatchObject({ worktree: folderKey, tabs: [] })
    expect(events.at(-1)).not.toHaveProperty('removed')
  })

  it('returns a stable tombstone for an unknown explicit folder after restart', async () => {
    const runtime = createRuntime({
      sessions: new Map([['local', getDefaultWorkspaceSession()]])
    })

    const first = await runtime.listMobileSessionTabs('id:folder:deleted-before-restart')
    const repeated = await runtime.listMobileSessionTabs('id:folder:deleted-before-restart')

    expect(first).toMatchObject({
      worktree: 'folder:deleted-before-restart',
      removed: true,
      tabs: []
    })
    expect(repeated).toEqual(first)
  })

  it('publishes empty state when a deleted folder identity is recreated empty', async () => {
    const folder = makeFolder('recreated-empty-folder', 'recreated-empty-group')
    const folderKey = `folder:${folder.id}`
    const folders = [folder]
    const runtime = createRuntime({
      folders,
      groups: [makeGroup(folder.projectGroupId)],
      sessions: new Map([['local', getDefaultWorkspaceSession()]])
    })
    await runtime.listAllMobileSessionTabs()
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    folders.length = 0
    const removed = await runtime.listAllMobileSessionTabs()
    folders.push(folder)
    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])

    expect(removed).toMatchObject([{ worktree: folderKey, removed: true, tabs: [] }])
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ worktree: folderKey, tabs: [] })
    expect(events.at(-1)).not.toHaveProperty('removed')
  })

  it('returns a tombstone when folder deletion races an explicit inventory read', async () => {
    const folder = makeFolder('explicit-race-folder', 'explicit-race-group')
    const folders = [folder]
    const runtime = createRuntime({
      folders,
      groups: [makeGroup(folder.projectGroupId)],
      sessions: new Map([['local', getDefaultWorkspaceSession()]])
    })
    const stalePtyId = 'stale-deleted-folder-pty'
    const staleProcess = {
      id: stalePtyId,
      cwd: folder.folderPath,
      title: 'Stale deleted folder',
      worktreeId: `folder:${folder.id}`,
      terminalHandle: 'term_stale_deleted_folder',
      incarnationId: INCARNATION_ID
    }
    let releaseInventory!: (sessions: (typeof staleProcess)[]) => void
    const inventory = new Promise<(typeof staleProcess)[]>((resolve) => {
      releaseInventory = resolve
    })
    const listProcesses = vi.fn(() => inventory)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const listing = runtime.listMobileSessionTabs(`id:folder:${folder.id}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    folders.length = 0
    releaseInventory([staleProcess])

    await expect(listing).resolves.toMatchObject({
      worktree: `folder:${folder.id}`,
      removed: true,
      tabs: []
    })
    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handleByPtyId: Map<string, string>
    }
    expect(internals.ptysById.has(stalePtyId)).toBe(false)
    expect(internals.handleByPtyId.has(stalePtyId)).toBe(false)
  })

  it('fences deleted folder PTYs during a Git-targeted inventory read', async () => {
    const folder = makeFolder('git-read-race-folder', 'git-read-race-group')
    const folderKey = `folder:${folder.id}`
    const folders = [folder]
    const repo: Repo = {
      id: 'git-read-race-repo',
      path: '/workspace/git-read-race-repo',
      displayName: 'Git read race repo',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const runtime = createRuntime({
      folders,
      groups: [makeGroup(folder.projectGroupId)],
      repos: [repo],
      sessions: new Map([['local', getDefaultWorkspaceSession()]])
    })
    const stalePtyId = 'stale-folder-pty-from-git-read'
    const staleProcess = {
      id: stalePtyId,
      cwd: folder.folderPath,
      title: 'Stale folder from Git read',
      worktreeId: folderKey,
      terminalHandle: 'term_stale_folder_from_git_read',
      incarnationId: INCARNATION_ID
    }
    let releaseInventory!: (sessions: (typeof staleProcess)[]) => void
    const inventory = new Promise<(typeof staleProcess)[]>((resolve) => {
      releaseInventory = resolve
    })
    const listProcesses = vi.fn(() => inventory)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    vi.spyOn(
      runtime as unknown as { listResolvedWorktrees: () => Promise<[]> },
      'listResolvedWorktrees'
    ).mockResolvedValue([])

    const listing = runtime.listMobileSessionTabs(`id:${repo.id}::${repo.path}`)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    folders.length = 0
    releaseInventory([staleProcess])

    await expect(listing).resolves.toMatchObject({ worktree: `${repo.id}::${repo.path}` })
    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handleByPtyId: Map<string, string>
    }
    expect(internals.ptysById.has(stalePtyId)).toBe(false)
    expect(internals.handleByPtyId.has(stalePtyId)).toBe(false)
  })

  it('rejects stale-generation PTY and handle mutations before retrying relay inventory', async () => {
    const connectionId = 'generation-fence-relay'
    const folder = makeFolder('generation-fence-folder', 'generation-fence-group')
    folder.connectionId = connectionId
    const folderKey = `folder:${folder.id}`
    const currentPtyId = `ssh:${connectionId}@@current-generation`
    const stalePtyId = `ssh:${connectionId}@@stale-generation`
    const runtime = createRuntime({
      folders: [folder],
      groups: [makeGroup(folder.projectGroupId)],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [toSshExecutionHostId(connectionId), makeSession(folderKey, currentPtyId)]
      ])
    })
    const process = (id: string, terminalHandle: string) => ({
      id,
      cwd: folder.folderPath,
      title: id,
      worktreeId: folderKey,
      terminalHandle,
      incarnationId: INCARNATION_ID
    })
    let releaseStale!: (value: ReturnType<typeof process>[]) => void
    let releaseCurrent!: (value: ReturnType<typeof process>[]) => void
    const staleInventory = new Promise<ReturnType<typeof process>[]>((resolve) => {
      releaseStale = resolve
    })
    const currentInventory = new Promise<ReturnType<typeof process>[]>((resolve) => {
      releaseCurrent = resolve
    })
    const listProcesses = vi
      .fn()
      .mockReturnValueOnce(staleInventory)
      .mockReturnValueOnce(currentInventory)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    vi.spyOn(
      runtime as unknown as { listResolvedWorktrees: () => Promise<[]> },
      'listResolvedWorktrees'
    ).mockResolvedValue([])
    vi.spyOn(
      runtime as unknown as {
        refreshRestoredOrchestrationAuthority: () => Promise<void>
      },
      'refreshRestoredOrchestrationAuthority'
    ).mockResolvedValue()
    vi.spyOn(runtime, 'reconcileLegacyWorkerTerminals').mockReturnValue(
      new Promise(() => undefined)
    )
    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handleByPtyId: Map<string, string>
    }

    runtime.notifySshRelayReady(connectionId)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    runtime.notifySshRelayReady(connectionId)
    releaseStale([process(stalePtyId, 'term_stale_generation')])
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(2))

    expect(internals.ptysById.has(stalePtyId)).toBe(false)
    expect(internals.handleByPtyId.has(stalePtyId)).toBe(false)
    releaseCurrent([process(currentPtyId, 'term_current_generation')])
    await vi.waitFor(() => expect(internals.ptysById.has(currentPtyId)).toBe(true))
  })

  it('uses the exact Git repo host for explicit duplicate-repo worktree reads', async () => {
    const repoId = 'duplicate-repo'
    const remotePath = '/remote/duplicate-repo'
    const remoteWorktreeId = `${repoId}::${remotePath}`
    const connectionId = 'duplicate-remote'
    const localRepo: Repo = {
      id: repoId,
      path: '/workspace/duplicate-repo',
      displayName: 'Local duplicate',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const remoteRepo: Repo = {
      ...localRepo,
      path: remotePath,
      displayName: 'Remote duplicate',
      connectionId
    }
    const remotePtyId = `ssh:${connectionId}@@explicit-remote`
    const runtime = createRuntime({
      repos: [localRepo, remoteRepo],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [toSshExecutionHostId(connectionId), makeSession(remoteWorktreeId, remotePtyId)]
      ])
    })

    const snapshot = await runtime.listMobileSessionTabs(`id:${remoteWorktreeId}`)

    expect(snapshot).toMatchObject({
      worktree: remoteWorktreeId,
      tabs: [{ parentTabId: TAB_ID, ptyId: remotePtyId }]
    })
  })

  it('prefers unique persisted ownership over a cross-host repo path collision', async () => {
    const repoId = 'cross-host-path-repo'
    const worktreeId = `${repoId}::/workspace/collision`
    const remoteHostId = toSshExecutionHostId('cross-host-owner')
    const remotePtyId = 'ssh:cross-host-owner@@persisted-remote'
    const runtime = createRuntime({
      repos: [
        {
          id: repoId,
          path: '/workspace/collision',
          displayName: 'Local path collision',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: null,
          addedAt: 1
        },
        {
          id: repoId,
          path: '/remote/repo',
          displayName: 'Remote owner',
          badgeColor: 'blue',
          connectionId: 'cross-host-owner',
          executionHostId: null,
          addedAt: 1
        }
      ],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [remoteHostId, makeSession(worktreeId, remotePtyId)]
      ])
    })

    await expect(runtime.listMobileSessionTabs(`id:${worktreeId}`)).resolves.toMatchObject({
      worktree: worktreeId,
      tabs: [{ ptyId: remotePtyId }]
    })
  })

  it('uses declared Git worktree ownership when duplicate host partitions share its key', async () => {
    const repoId = 'declared-duplicate-repo'
    const worktreeId = `${repoId}::/worktrees/feature`
    const remoteHostId = toRuntimeExecutionHostId('declared-worktree-owner')
    const localPtyId = 'serve-stale-local-owner'
    const remotePtyId = 'serve-declared-remote-owner'
    const repos: Repo[] = [
      {
        id: repoId,
        path: '/workspace/declared-duplicate-repo',
        displayName: 'Local duplicate',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: null,
        addedAt: 1
      },
      {
        id: repoId,
        path: '/remote/declared-duplicate-repo',
        displayName: 'Remote duplicate',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: remoteHostId,
        addedAt: 1
      }
    ]
    const args = {
      repos,
      worktreeHosts: { [worktreeId]: remoteHostId },
      sessions: new Map<ExecutionHostId, WorkspaceSessionState>([
        ['local', makeSession(worktreeId, localPtyId)],
        [remoteHostId, makeSession(worktreeId, remotePtyId)]
      ])
    }

    const aggregateRuntime = createRuntime(args)
    aggregateRuntime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: remotePtyId,
          cwd: '/worktrees/feature',
          title: 'Declared remote',
          worktreeId,
          terminalHandle: 'term_declared_remote',
          incarnationId: INCARNATION_ID
        }
      ]
    })
    const aggregate = await aggregateRuntime.listAllMobileSessionTabs()
    const explicit = await createRuntime(args).listMobileSessionTabs(`id:${worktreeId}`)

    expect(aggregate).toEqual([
      expect.objectContaining({
        worktree: worktreeId,
        tabs: [expect.objectContaining({ ptyId: remotePtyId })]
      })
    ])
    expect(explicit).toMatchObject({
      worktree: worktreeId,
      tabs: [{ ptyId: remotePtyId }]
    })
    expect(
      (
        aggregateRuntime as unknown as {
          ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
        }
      ).ptysById.get(remotePtyId)
    ).toMatchObject({
      tabId: TAB_ID,
      paneKey: makePaneKey(TAB_ID, LEAF_ID)
    })
  })

  it('does not route a declared local Git workspace through a duplicate SSH transport', () => {
    const repoId = 'declared-local-duplicate'
    const worktreeId = `${repoId}::/workspace/declared-local`
    const connectionId = 'unrelated-duplicate-relay'
    const localRepo: Repo = {
      id: repoId,
      path: '/workspace/declared-local',
      displayName: 'Declared local',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const runtime = createRuntime({
      repos: [
        localRepo,
        {
          ...localRepo,
          path: '/remote/unrelated-duplicate',
          displayName: 'Unrelated remote',
          connectionId
        }
      ],
      worktreeHosts: { [worktreeId]: 'local' },
      sessions: new Map([['local', makeSession(worktreeId, 'declared-local-pty')]])
    })
    const workspaceUsesSshRelayTarget = (
      runtime as unknown as {
        workspaceUsesSshRelayTarget: (
          candidateWorktreeId: string,
          targetId: string,
          persistedHostIds: ReadonlySet<ExecutionHostId>,
          inventory: {
            folderWorkspaces: FolderWorkspace[]
            repos: Repo[]
            projectGroups: ProjectGroup[]
          }
        ) => boolean
      }
    ).workspaceUsesSshRelayTarget.bind(runtime)

    expect(
      workspaceUsesSshRelayTarget(worktreeId, connectionId, new Set(['local']), {
        folderWorkspaces: [],
        repos: [
          localRepo,
          {
            ...localRepo,
            path: '/remote/unrelated-duplicate',
            connectionId
          }
        ],
        projectGroups: []
      })
    ).toBe(false)
  })

  it('does not surface the legacy-local copy of an ambiguous Git session key', async () => {
    const repoId = 'ambiguous-duplicate-repo'
    const worktreeId = `${repoId}::/worktrees/shared-feature`
    const remoteHostId = toRuntimeExecutionHostId('ambiguous-worktree-owner')
    const repos: Repo[] = [
      {
        id: repoId,
        path: '/workspace/ambiguous-duplicate-repo',
        displayName: 'Local duplicate',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: null,
        addedAt: 1
      },
      {
        id: repoId,
        path: '/remote/ambiguous-duplicate-repo',
        displayName: 'Remote duplicate',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: remoteHostId,
        addedAt: 1
      }
    ]
    const runtime = createRuntime({
      repos,
      sessions: new Map([
        ['local', makeSession(worktreeId, 'stale-local-pty')],
        [remoteHostId, makeSession(worktreeId, 'remote-pty')]
      ])
    })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
  })

  it('does not surface a stale local Git session when its declared owner is empty', async () => {
    const repoId = 'moved-duplicate-repo'
    const worktreeId = `${repoId}::/worktrees/moved-feature`
    const remoteHostId = toRuntimeExecutionHostId('moved-worktree-owner')
    const runtime = createRuntime({
      repos: [
        {
          id: repoId,
          path: '/workspace/moved-duplicate-repo',
          displayName: 'Local duplicate',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: null,
          addedAt: 1
        },
        {
          id: repoId,
          path: '/remote/moved-duplicate-repo',
          displayName: 'Remote duplicate',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: remoteHostId,
          addedAt: 1
        }
      ],
      worktreeHosts: { [worktreeId]: remoteHostId },
      sessions: new Map([
        ['local', makeSession(worktreeId, 'stale-local-pty')],
        [remoteHostId, getDefaultWorkspaceSession()]
      ])
    })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
  })

  it('does not surface a stale local Git session owned by one remote repo', async () => {
    const repoId = 'single-remote-owner-repo'
    const worktreeId = `${repoId}::/remote/single-owner/worktree`
    const remoteHostId = toRuntimeExecutionHostId('single-remote-owner')
    const runtime = createRuntime({
      repos: [
        {
          id: repoId,
          path: '/remote/single-owner',
          displayName: 'Single remote owner',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: remoteHostId,
          addedAt: 1
        }
      ],
      sessions: new Map([
        ['local', makeSession(worktreeId, 'stale-single-owner-local-pty')],
        [remoteHostId, getDefaultWorkspaceSession()]
      ])
    })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
    await expect(runtime.listMobileSessionTabs(`id:${worktreeId}`)).resolves.toMatchObject({
      worktree: worktreeId,
      tabs: []
    })
  })
})
