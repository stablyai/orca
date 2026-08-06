import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { FolderWorkspace, Repo, WorkspaceSessionState } from '../../shared/types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
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

const REPO_ID = 'inventory-fencing-repo'
const INCARNATION_ID = '55555555-5555-4555-8555-555555555555'

function makeSession(args: {
  worktreeId: string
  ptyId: string
  tabId: string
  leafId: string
}): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  session.tabsByWorktree = {
    [args.worktreeId]: [
      {
        id: args.tabId,
        ptyId: args.ptyId,
        worktreeId: args.worktreeId,
        title: args.tabId,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  session.terminalLayoutsByTabId = {
    [args.tabId]: {
      root: { type: 'leaf', leafId: args.leafId },
      activeLeafId: args.leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [args.leafId]: args.ptyId }
    }
  }
  session.terminalPtyIncarnationsByPaneKey = {
    [makePaneKey(args.tabId, args.leafId)]: INCARNATION_ID
  }
  return session
}

function createRuntime(
  args: {
    repos?: Repo[]
    folders?: FolderWorkspace[]
    worktreeHosts?: Record<string, ExecutionHostId>
    sessions?: Map<ExecutionHostId, WorkspaceSessionState>
  } = {}
): OrcaRuntimeService {
  const sessions = args.sessions ?? new Map([['local', getDefaultWorkspaceSession()]])
  return new OrcaRuntimeService({
    getRepo: (id: string) => args.repos?.find((repo) => repo.id === id),
    getRepos: () => args.repos ?? [],
    getFolderWorkspaces: () => args.folders ?? [],
    getProjectGroups: () => [],
    getWorkspaceSession: (hostId?: string | null) =>
      sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
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

describe('mobile PTY inventory fencing', () => {
  it('clears stale SSH ownership when a PTY is subsequently inventoried locally', async () => {
    const ptyId = 'provider-reused-unprefixed-pty'
    const worktreeId = `${REPO_ID}::/workspace/provider-reused`
    const process = {
      id: ptyId,
      cwd: '/workspace/provider-reused',
      title: 'Provider reused',
      worktreeId,
      terminalHandle: 'term_provider_reused',
      incarnationId: INCARNATION_ID
    }
    const listProcesses = vi.fn(async () => [process])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const internals = runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: (
        worktrees: [],
        targetWorktreeId: null,
        deadline: undefined,
        connectionId?: string | null
      ) => Promise<unknown>
      ptysById: Map<string, { connected: boolean; connectionId: string | null }>
    }

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      'provider-reused-relay'
    )
    expect(internals.ptysById.get(ptyId)?.connectionId).toBe('provider-reused-relay')

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, null)
    expect(internals.ptysById.get(ptyId)).toMatchObject({ connected: true, connectionId: null })

    listProcesses.mockResolvedValue([])
    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      'provider-reused-relay'
    )
    expect(internals.ptysById.get(ptyId)?.connected).toBe(true)
  })

  it('coalesces repeated provider refreshes while another provider is pending', async () => {
    const runtime = createRuntime()
    let releaseA!: (sessions: []) => void
    let releaseB!: (sessions: []) => void
    const inventoryA = new Promise<[]>((resolve) => {
      releaseA = resolve
    })
    const inventoryB = new Promise<[]>((resolve) => {
      releaseB = resolve
    })
    const listProcesses = vi.fn((connectionId?: string | null) =>
      connectionId === 'relay-a' ? inventoryA : inventoryB
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const refresh = (
      runtime as unknown as {
        refreshMobileSessionPtyRecords: (
          worktreeId: null,
          fence: undefined,
          connectionId: string
        ) => Promise<unknown>
      }
    ).refreshMobileSessionPtyRecords.bind(runtime)

    const pendingA = refresh(null, undefined, 'relay-a')
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    const pendingB1 = refresh(null, undefined, 'relay-b')
    const pendingB2 = refresh(null, undefined, 'relay-b')
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(2))

    releaseB([])
    await Promise.all([pendingB1, pendingB2])
    releaseA([])
    await pendingA
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })

  it('accepts provider inventories when a newer overlapping aggregate is rejected', async () => {
    const runtime = createRuntime()
    const makeProcess = (connectionId: string) => ({
      id: `ssh:${connectionId}@@overlap-pty`,
      cwd: `/remote/${connectionId}`,
      title: connectionId,
      worktreeId: `${REPO_ID}::/remote/${connectionId}`,
      terminalHandle: `term_${connectionId}`,
      incarnationId: INCARNATION_ID
    })
    let releaseA!: (sessions: ReturnType<typeof makeProcess>[]) => void
    let releaseAggregate!: (sessions: ReturnType<typeof makeProcess>[]) => void
    let releaseB!: (sessions: ReturnType<typeof makeProcess>[]) => void
    const inventoryA = new Promise<ReturnType<typeof makeProcess>[]>((resolve) => {
      releaseA = resolve
    })
    const aggregateInventory = new Promise<ReturnType<typeof makeProcess>[]>((resolve) => {
      releaseAggregate = resolve
    })
    const inventoryB = new Promise<ReturnType<typeof makeProcess>[]>((resolve) => {
      releaseB = resolve
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async (connectionId) =>
        connectionId === 'relay-a'
          ? inventoryA
          : connectionId === 'relay-b'
            ? inventoryB
            : aggregateInventory
    })
    const internals = runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: (
        worktrees: [],
        targetWorktreeId: null,
        deadline: undefined,
        connectionId?: string
      ) => Promise<unknown>
      ptysById: Map<string, unknown>
    }

    const pendingA = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      'relay-a'
    )
    const pendingAggregate = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined
    )
    const pendingB = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      'relay-b'
    )
    releaseB([makeProcess('relay-b')])
    await pendingB
    releaseAggregate([])
    await expect(pendingAggregate).resolves.toBeNull()
    releaseA([makeProcess('relay-a')])
    await pendingA

    expect(internals.ptysById.has('ssh:relay-a@@overlap-pty')).toBe(true)
    expect(internals.ptysById.has('ssh:relay-b@@overlap-pty')).toBe(true)
  })

  it('hydrates relay recovery from declared worktree ownership', async () => {
    const connectionId = 'declared-runtime-relay'
    const worktreeId = `${REPO_ID}::/runtime/worktrees/declared`
    const runtimeHostId = toRuntimeExecutionHostId('declared-runtime-owner')
    const binding = {
      worktreeId,
      ptyId: `ssh:${connectionId}@@declared-runtime-pty`,
      tabId: 'declared-runtime-tab',
      leafId: 'abababab-abab-4bab-8bab-abababababab'
    }
    const repo: Repo = {
      id: REPO_ID,
      path: '/remote/declared-runtime-repo',
      displayName: 'Declared runtime owner',
      badgeColor: 'blue',
      connectionId,
      executionHostId: null,
      addedAt: 1
    }
    const runtime = createRuntime({
      repos: [repo],
      worktreeHosts: { [worktreeId]: runtimeHostId },
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [runtimeHostId, makeSession(binding)]
      ])
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: binding.ptyId,
          cwd: '/runtime/worktrees/declared',
          title: 'Declared runtime',
          worktreeId,
          terminalHandle: 'term_declared_runtime',
          incarnationId: INCARNATION_ID
        }
      ]
    })
    vi.spyOn(
      runtime as unknown as {
        refreshRestoredOrchestrationAuthority: () => Promise<void>
      },
      'refreshRestoredOrchestrationAuthority'
    ).mockResolvedValue()
    vi.spyOn(runtime, 'reconcileLegacyWorkerTerminals').mockReturnValue(
      new Promise(() => undefined)
    )
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.notifySshRelayReady(connectionId)

    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        worktree: worktreeId,
        tabs: [{ parentTabId: binding.tabId, terminal: 'term_declared_runtime' }]
      })
    )
    const internals = runtime as unknown as {
      ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
    }
    expect(internals.ptysById.get(binding.ptyId)).toMatchObject({
      tabId: binding.tabId,
      paneKey: makePaneKey(binding.tabId, binding.leafId)
    })
  })

  it('hydrates an attached explicit Git read from its scoped owner alias', async () => {
    const worktreeId = `${REPO_ID}::/workspace/scoped-explicit`
    const ownerKey = worktreeWorkspaceKey(worktreeId)
    const tabId = 'scoped-explicit-tab'
    const leafId = '12121212-1212-4212-8212-121212121212'
    const session = makeSession({
      worktreeId: ownerKey,
      ptyId: 'serve-scoped-explicit-pty',
      tabId,
      leafId
    })
    const runtime = createRuntime({
      repos: [
        {
          id: REPO_ID,
          path: '/workspace/scoped-explicit',
          displayName: 'Scoped explicit',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: null,
          addedAt: 1
        }
      ],
      sessions: new Map([['local', session]])
    })
    runtime.attachWindow(17)

    const snapshot = await runtime.listMobileSessionTabs(`id:${worktreeId}`)

    expect(snapshot).toMatchObject({
      worktree: worktreeId,
      tabs: [{ parentTabId: tabId, leafId, ptyId: 'serve-scoped-explicit-pty' }]
    })
  })

  it('hydrates scoped serve and SSH tabs during isolated relay recovery', async () => {
    const connectionId = 'scoped-owner-relay'
    const worktreeId = `${REPO_ID}::/remote/scoped-owner`
    const ownerKey = worktreeWorkspaceKey(worktreeId)
    const sshTabId = 'scoped-relay-ssh-tab'
    const sshLeafId = '23232323-2323-4232-8232-232323232323'
    const serveTabId = 'scoped-relay-serve-tab'
    const serveLeafId = '34343434-3434-4343-8343-343434343434'
    const sshPtyId = `ssh:${connectionId}@@scoped-relay-pty`
    const session = makeSession({
      worktreeId: ownerKey,
      ptyId: sshPtyId,
      tabId: sshTabId,
      leafId: sshLeafId
    })
    session.tabsByWorktree[ownerKey]!.push({
      id: serveTabId,
      ptyId: 'serve-scoped-relay-pty',
      worktreeId: ownerKey,
      title: 'Scoped serve',
      customTitle: null,
      color: null,
      sortOrder: 1,
      createdAt: 1
    })
    session.terminalLayoutsByTabId[serveTabId] = {
      root: { type: 'leaf', leafId: serveLeafId },
      activeLeafId: serveLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [serveLeafId]: 'serve-scoped-relay-pty' }
    }
    const unrelatedWorktreeId = `${REPO_ID}::/local/unrelated`
    const unrelatedSession = makeSession({
      worktreeId: unrelatedWorktreeId,
      ptyId: 'serve-unrelated-pty',
      tabId: 'unrelated-tab',
      leafId: '45454545-4545-4454-8454-454545454545'
    })
    const runtime = createRuntime({
      repos: [
        {
          id: REPO_ID,
          path: '/local/unrelated',
          displayName: 'Unrelated local',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: null,
          addedAt: 1
        },
        {
          id: REPO_ID,
          path: '/remote/scoped-owner',
          displayName: 'Scoped relay',
          badgeColor: 'blue',
          connectionId,
          executionHostId: null,
          addedAt: 1
        }
      ],
      sessions: new Map([
        ['local', unrelatedSession],
        [toSshExecutionHostId(connectionId), session]
      ])
    })
    const listProcesses = vi.fn(async () => [
      {
        id: sshPtyId,
        cwd: '/remote/scoped-owner',
        title: 'Scoped SSH',
        worktreeId,
        terminalHandle: 'term_scoped_relay',
        incarnationId: INCARNATION_ID
      }
    ])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    vi.spyOn(
      runtime as unknown as { refreshRestoredOrchestrationAuthority: () => Promise<void> },
      'refreshRestoredOrchestrationAuthority'
    ).mockResolvedValue()
    vi.spyOn(runtime, 'reconcileLegacyWorkerTerminals').mockReturnValue(
      new Promise(() => undefined)
    )
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.notifySshRelayReady(connectionId)

    await vi.waitFor(() =>
      expect(
        events
          .at(-1)
          ?.tabs.filter((tab) => tab.type === 'terminal')
          .map((tab) => tab.parentTabId)
      ).toEqual(expect.arrayContaining([sshTabId, serveTabId]))
    )
    expect(events.at(-1)?.worktree).toBe(worktreeId)
    expect(events.flatMap((snapshot) => snapshot.tabs)).not.toContainEqual(
      expect.objectContaining({ parentTabId: 'unrelated-tab' })
    )
    expect(listProcesses).toHaveBeenCalledWith(connectionId)
  })

  it('fences PTY mutations when a folder path changes in place during inventory', async () => {
    const folder: FolderWorkspace = {
      id: 'moved-during-inventory',
      projectGroupId: 'moved-during-inventory-group',
      name: 'Moved folder',
      folderPath: '/workspace/moved-during-inventory',
      connectionId: null,
      executionHostId: null,
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
    const worktreeId = `folder:${folder.id}`
    const ptyId = `${worktreeId}@@old-path-pty`
    const runtime = createRuntime({
      folders: [folder],
      sessions: new Map([
        ['local', makeSession({ worktreeId, ptyId, tabId: 'old-path-tab', leafId: INCARNATION_ID })]
      ])
    })
    const process = {
      id: ptyId,
      cwd: folder.folderPath,
      title: 'Old folder path',
      worktreeId,
      terminalHandle: 'term_old_folder_path',
      incarnationId: INCARNATION_ID
    }
    let releaseInventory!: (value: (typeof process)[]) => void
    const inventory = new Promise<(typeof process)[]>((resolve) => {
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
    folder.folderPath = '/workspace/moved-during-inventory-new'
    releaseInventory([process])
    await listing

    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handleByPtyId: Map<string, string>
    }
    expect(internals.ptysById.has(ptyId)).toBe(false)
    expect(internals.handleByPtyId.has(ptyId)).toBe(false)
  })

  it('retries relay inventory after same-generation folder routing metadata changes', async () => {
    const connectionId = 'same-generation-relay'
    const folder: FolderWorkspace = {
      id: 'same-generation-folder',
      projectGroupId: 'same-generation-group',
      name: 'Same generation folder',
      folderPath: '/remote/same-generation-old',
      connectionId,
      executionHostId: null,
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
    const worktreeId = `folder:${folder.id}`
    const currentPtyId = `ssh:${connectionId}@@same-generation-current`
    const stalePtyId = `ssh:${connectionId}@@same-generation-stale`
    const runtime = createRuntime({
      folders: [folder],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [
          toSshExecutionHostId(connectionId),
          makeSession({
            worktreeId,
            ptyId: currentPtyId,
            tabId: 'same-generation-tab',
            leafId: '12121212-1212-4212-8212-121212121212'
          })
        ]
      ])
    })
    const makeProcess = (id: string, terminalHandle: string) => ({
      id,
      cwd: folder.folderPath,
      title: terminalHandle,
      worktreeId,
      terminalHandle,
      incarnationId: INCARNATION_ID
    })
    let releaseStaleInventory!: (value: ReturnType<typeof makeProcess>[]) => void
    const staleInventory = new Promise<ReturnType<typeof makeProcess>[]>((resolve) => {
      releaseStaleInventory = resolve
    })
    const listProcesses = vi
      .fn()
      .mockReturnValueOnce(staleInventory)
      .mockResolvedValueOnce([makeProcess(currentPtyId, 'term_same_generation_current')])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      sshRelayRecoveryGenerationByTargetId: Map<string, number>
      publishRecoveredSshMobileSessionTabs: (
        targetId: string,
        generation: number,
        generationIsCurrent: () => boolean
      ) => Promise<void>
    }
    internals.sshRelayRecoveryGenerationByTargetId.set(connectionId, 1)

    const recovery = internals.publishRecoveredSshMobileSessionTabs(connectionId, 1, () => true)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    folder.folderPath = '/remote/same-generation-new'
    releaseStaleInventory([makeProcess(stalePtyId, 'term_same_generation_stale')])
    await recovery

    expect(listProcesses).toHaveBeenCalledTimes(2)
    expect(internals.ptysById.has(stalePtyId)).toBe(false)
    expect(internals.ptysById.has(currentPtyId)).toBe(true)
  })

  it('invalidates a folder inventory fence when inferred transport routing changes', () => {
    const folder: FolderWorkspace = {
      id: 'inferred-routing-folder',
      projectGroupId: 'inferred-routing-group',
      name: 'Inferred routing folder',
      folderPath: '/workspace/inferred-routing',
      connectionId: null,
      executionHostId: null,
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
    const repos: Repo[] = [
      {
        id: 'inferred-routing-repo',
        path: '/workspace/inferred-routing/local',
        displayName: 'Local child',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: null,
        addedAt: 1
      }
    ]
    const runtime = createRuntime({ folders: [folder], repos })
    const createFence = (
      runtime as unknown as {
        createFolderWorkspaceInventoryFence: (folders: FolderWorkspace[]) => () => boolean
      }
    ).createFolderWorkspaceInventoryFence.bind(runtime)
    const fence = createFence([folder])
    expect(fence()).toBe(true)

    repos.push({
      ...repos[0]!,
      id: 'inferred-routing-remote-repo',
      path: '/workspace/inferred-routing/remote',
      displayName: 'Remote child',
      connectionId: 'inferred-routing-relay'
    })

    expect(fence()).toBe(false)
  })

  it('evicts a cached Git snapshot when its persisted host becomes ambiguous', async () => {
    const repoId = 'cached-ambiguous-repo'
    const worktreeId = `${repoId}::/worktrees/cached-feature`
    const runtimeHostId = toRuntimeExecutionHostId('cached-ambiguous-owner')
    const repos: Repo[] = [
      {
        id: repoId,
        path: '/workspace/cached-ambiguous-repo',
        displayName: 'Cached local owner',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: null,
        addedAt: 1
      }
    ]
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [
        'local',
        makeSession({
          worktreeId,
          ptyId: 'cached-local-pty',
          tabId: 'cached-local-tab',
          leafId: '66666666-6666-4666-8666-666666666666'
        })
      ]
    ])
    const runtime = createRuntime({ repos, sessions })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toHaveLength(1)
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    repos.push({
      ...repos[0]!,
      path: '/runtime/cached-ambiguous-repo',
      displayName: 'Cached runtime owner',
      executionHostId: runtimeHostId
    })
    sessions.set(
      runtimeHostId,
      makeSession({
        worktreeId,
        ptyId: 'cached-runtime-pty',
        tabId: 'cached-runtime-tab',
        leafId: '77777777-7777-4777-8777-777777777777'
      })
    )

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
    await expect(runtime.listMobileSessionTabs(`id:${worktreeId}`)).resolves.toMatchObject({
      worktree: worktreeId,
      tabs: []
    })
    expect(events.at(-1)).toMatchObject({ worktree: worktreeId, removed: true, tabs: [] })
  })

  it('evicts a cached Git snapshot when raw and scoped owners collide', async () => {
    const repoId = 'cached-alias-collision-repo'
    const worktreeId = `${repoId}::/worktrees/cached-feature`
    const session = makeSession({
      worktreeId,
      ptyId: 'cached-raw-pty',
      tabId: 'cached-raw-tab',
      leafId: '88888888-8888-4888-8888-888888888888'
    })
    const runtime = createRuntime({
      repos: [
        {
          id: repoId,
          path: '/workspace/cached-alias-collision-repo',
          displayName: 'Cached alias owner',
          badgeColor: 'blue',
          connectionId: null,
          executionHostId: null,
          addedAt: 1
        }
      ],
      sessions: new Map([['local', session]])
    })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toHaveLength(1)
    session.tabsByWorktree[worktreeWorkspaceKey(worktreeId)] = [
      {
        ...session.tabsByWorktree[worktreeId]![0]!,
        id: 'cached-scoped-tab',
        ptyId: 'cached-scoped-pty',
        worktreeId: worktreeWorkspaceKey(worktreeId)
      }
    ]

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
    await expect(runtime.listMobileSessionTabs(`id:${worktreeId}`)).resolves.toMatchObject({
      worktree: worktreeId,
      tabs: []
    })
  })
})
