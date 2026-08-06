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

const REPO_ID = 'duplicate-owner-repo'
const WORKTREE_ID = `${REPO_ID}::/workspace/duplicate-owner`
const CONNECTION_ID = 'duplicate-owner-ssh'
const INCARNATION_ID = '55555555-5555-4555-8555-555555555555'

function makeSession(
  bindings: { ptyId: string; tabId: string; leafId: string }[],
  worktreeId = WORKTREE_ID
): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  session.tabsByWorktree = {
    [worktreeId]: bindings.map(({ ptyId, tabId }, sortOrder) => ({
      id: tabId,
      ptyId,
      worktreeId,
      title: tabId,
      customTitle: null,
      color: null,
      sortOrder,
      createdAt: sortOrder + 1
    }))
  }
  session.terminalLayoutsByTabId = Object.fromEntries(
    bindings.map(({ ptyId, tabId, leafId }) => [
      tabId,
      {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    ])
  )
  session.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
    bindings.map(({ tabId, leafId }) => [makePaneKey(tabId, leafId), INCARNATION_ID])
  )
  return session
}

function createPartitionRuntime(args: {
  repos?: Repo[]
  folders?: FolderWorkspace[]
  groups?: ProjectGroup[]
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
}) {
  const getFolderWorkspaces = vi.fn(() => args.folders ?? [])
  const getProjectGroups = vi.fn(() => args.groups ?? [])
  const getRepos = vi.fn(() => args.repos ?? [])
  const getWorkspaceSession = vi.fn(
    (hostId?: string | null) =>
      args.sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession()
  )
  const getWorkspaceSessionHostIds = vi.fn(() => [...args.sessions.keys()])
  const runtime = new OrcaRuntimeService({
    getRepo: (id: string) => args.repos?.find((repo) => repo.id === id),
    getRepos,
    getFolderWorkspaces,
    getProjectGroups,
    getWorkspaceSession,
    getWorkspaceSessionHostIds,
    removeFolderWorkspace: (folderWorkspaceId: string) => {
      const index = args.folders?.findIndex((folder) => folder.id === folderWorkspaceId) ?? -1
      if (index < 0) {
        return false
      }
      args.folders!.splice(index, 1)
      return true
    },
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
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
  return {
    runtime,
    getFolderWorkspaces,
    getProjectGroups,
    getRepos,
    getWorkspaceSession,
    getWorkspaceSessionHostIds
  }
}

async function refreshInventory(
  runtime: OrcaRuntimeService,
  connectionId?: string | null
): Promise<void> {
  await (
    runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: (
        worktrees: [],
        targetWorktreeId: null,
        deadline: undefined,
        connectionId?: string | null
      ) => Promise<unknown>
    }
  ).refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId)
}

function expectExactSurface(
  runtime: OrcaRuntimeService,
  binding: { ptyId: string; tabId: string; leafId: string },
  handle: string
): void {
  const internals = runtime as unknown as {
    ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
    handleByPtyId: Map<string, string>
  }
  expect(internals.ptysById.get(binding.ptyId)).toMatchObject({
    tabId: binding.tabId,
    paneKey: makePaneKey(binding.tabId, binding.leafId)
  })
  expect(internals.handleByPtyId.get(binding.ptyId)).toBe(handle)
}

function makeFolderWorkspace(
  id: string,
  projectGroupId: string,
  connectionId: string | null,
  executionHostId: ExecutionHostId | null
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId,
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

function makeProjectGroup(
  id: string,
  connectionId: string | null,
  executionHostId: ExecutionHostId | null
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: `/workspace/${id}`,
    connectionId,
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

describe('mobile PTY persisted host partition', () => {
  it('keeps aggregate local Git PTYs local when duplicate repo ids span hosts', async () => {
    const localPtyId = 'unprefixed-local-pty'
    const explicitSshPtyId = 'unprefixed-explicit-ssh-pty'
    const prefixedSshPtyId = `ssh:${CONNECTION_ID}@@prefixed-ssh-pty`
    const localBinding = {
      ptyId: localPtyId,
      tabId: 'local-tab',
      leafId: '11111111-1111-4111-8111-111111111111'
    }
    const explicitBinding = {
      ptyId: explicitSshPtyId,
      tabId: 'explicit-ssh-tab',
      leafId: '22222222-2222-4222-8222-222222222222'
    }
    const prefixedBinding = {
      ptyId: prefixedSshPtyId,
      tabId: 'prefixed-ssh-tab',
      leafId: '33333333-3333-4333-8333-333333333333'
    }
    const wrongLocalBinding = {
      ptyId: localPtyId,
      tabId: 'wrong-ssh-local-tab',
      leafId: '44444444-4444-4444-8444-444444444444'
    }
    const localSession = makeSession([localBinding])
    const sshSession = makeSession([wrongLocalBinding, explicitBinding, prefixedBinding])
    const localRepo = {
      id: REPO_ID,
      path: '/workspace/duplicate-owner',
      displayName: 'Local duplicate',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const sshRepo = {
      ...localRepo,
      path: '/remote/duplicate-owner',
      displayName: 'SSH duplicate',
      connectionId: CONNECTION_ID
    }
    const getProjectGroups = vi.fn(() => [])
    const getWorkspaceSessionHostIds = vi.fn(() => ['local', `ssh:${CONNECTION_ID}`] as const)
    const runtime = new OrcaRuntimeService({
      getRepo: () => sshRepo,
      getRepos: () => [sshRepo, localRepo],
      getProjectGroups,
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getGitHubCache: () => ({ pr: {}, issue: {} }),
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getWorkspaceSession: (hostId?: string | null) =>
        hostId === `ssh:${CONNECTION_ID}` ? sshSession : localSession,
      getWorkspaceSessionHostIds,
      getSettings: () => ({
        workspaceDir: '/workspace',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      })
    } as never)
    const process = (id: string, terminalHandle: string) => ({
      id,
      cwd: '/workspace/duplicate-owner',
      title: id,
      worktreeId: WORKTREE_ID,
      terminalHandle,
      incarnationId: INCARNATION_ID
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async (connectionId) =>
        connectionId === CONNECTION_ID
          ? [process(explicitSshPtyId, 'term_explicit_ssh')]
          : [process(localPtyId, 'term_local'), process(prefixedSshPtyId, 'term_prefixed_ssh')]
    })
    const internals = runtime as unknown as {
      getKnownWorkspaceSessionWorktrees: (folders: FolderWorkspace[]) => {
        worktreeIds: Set<string>
      }
      refreshPtyWorktreeRecordsWithControllerInventory: (
        worktrees: [],
        targetWorktreeId?: string | null,
        deadline?: number,
        connectionId?: string | null
      ) => Promise<unknown>
      ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
      handleByPtyId: Map<string, string>
    }
    const folders = Array.from(
      { length: 200 },
      (_, index) => ({ id: `folder-${index}` }) as FolderWorkspace
    )

    internals.getKnownWorkspaceSessionWorktrees(folders)

    expect(getWorkspaceSessionHostIds).toHaveBeenCalledOnce()
    expect(getProjectGroups).not.toHaveBeenCalled()

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([])
    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      CONNECTION_ID
    )

    expect(internals.ptysById.get(localPtyId)).toMatchObject({
      tabId: localBinding.tabId,
      paneKey: makePaneKey(localBinding.tabId, localBinding.leafId)
    })
    expect(internals.ptysById.get(prefixedSshPtyId)).toMatchObject({
      tabId: prefixedBinding.tabId,
      paneKey: makePaneKey(prefixedBinding.tabId, prefixedBinding.leafId)
    })
    expect(internals.ptysById.get(explicitSshPtyId)).toMatchObject({
      tabId: explicitBinding.tabId,
      paneKey: makePaneKey(explicitBinding.tabId, explicitBinding.leafId)
    })
    expect(internals.handleByPtyId).toMatchObject(
      new Map([
        [localPtyId, 'term_local'],
        [prefixedSshPtyId, 'term_prefixed_ssh'],
        [explicitSshPtyId, 'term_explicit_ssh']
      ])
    )
  })

  it.each([
    ['workspace runtime aggregate', 'workspace-runtime', undefined],
    ['workspace runtime targeted', 'workspace-runtime', 'private-relay'],
    ['group runtime aggregate', 'group-runtime', undefined],
    ['group runtime targeted', 'group-runtime', 'private-relay'],
    ['declared SSH aggregate', 'workspace-ssh', undefined],
    ['declared SSH targeted', 'workspace-ssh-targeted', 'private-relay']
  ] as const)(
    'restores exact folder identity for %s inventory',
    async (_name, owner, scanTarget) => {
      const folderId = `folder-${owner}`
      const folderKey = `folder:${folderId}`
      const groupId = `group-${owner}`
      const runtimeHostId = toRuntimeExecutionHostId(`${owner}-host`)
      const sshOwned = owner.startsWith('workspace-ssh')
      const declaredHostId = sshOwned ? toSshExecutionHostId('declared') : runtimeHostId
      const connectionId = owner === 'workspace-ssh' ? null : 'private-relay'
      const folder = makeFolderWorkspace(
        folderId,
        groupId,
        connectionId,
        owner.startsWith('workspace') ? declaredHostId : null
      )
      const group = makeProjectGroup(
        groupId,
        connectionId,
        owner === 'group-runtime' ? runtimeHostId : null
      )
      const hostId = sshOwned ? toSshExecutionHostId('declared') : runtimeHostId
      const ptyId = connectionId ? `ssh:${connectionId}@@${owner}` : `pty-${owner}`
      const binding = {
        ptyId,
        tabId: `tab-${owner}`,
        leafId: '66666666-6666-4666-8666-666666666666'
      }
      const { runtime } = createPartitionRuntime({
        folders: [folder],
        groups: [group],
        sessions: new Map([
          ['local', getDefaultWorkspaceSession()],
          [hostId, makeSession([binding], folderKey)]
        ])
      })
      const handle = `term_${owner.replaceAll('-', '_')}`
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [
          {
            id: ptyId,
            cwd: folder.folderPath,
            title: owner,
            worktreeId: folderKey,
            terminalHandle: handle,
            incarnationId: INCARNATION_ID
          }
        ]
      })

      await refreshInventory(runtime, scanTarget)

      expectExactSurface(runtime, binding, handle)
    }
  )

  it.each([
    [
      'runtime aggregate',
      toRuntimeExecutionHostId('git-owner'),
      'runtime-private-relay',
      undefined
    ],
    [
      'runtime targeted',
      toRuntimeExecutionHostId('git-owner'),
      'runtime-private-relay',
      'runtime-private-relay'
    ],
    [
      'declared SSH targeted',
      toSshExecutionHostId('git-owner'),
      'git-private-relay',
      'git-private-relay'
    ]
  ] as const)('restores %s Git identity', async (_name, hostId, connectionId, scanTarget) => {
    const ptyId = `ssh:${connectionId}@@runtime-git`
    const binding = {
      ptyId,
      tabId: 'runtime-git-tab',
      leafId: '77777777-7777-4777-8777-777777777777'
    }
    const repo: Repo = {
      id: REPO_ID,
      path: '/workspace/duplicate-owner',
      displayName: 'Runtime Git',
      badgeColor: 'blue',
      connectionId,
      executionHostId: hostId,
      addedAt: 1
    }
    const { runtime } = createPartitionRuntime({
      repos: [repo],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [hostId, makeSession([binding])]
      ])
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: ptyId,
          cwd: repo.path,
          title: 'Runtime Git',
          worktreeId: WORKTREE_ID,
          terminalHandle: 'term_runtime_git',
          incarnationId: INCARNATION_ID
        }
      ]
    })

    await refreshInventory(runtime, scanTarget)

    expectExactSurface(runtime, binding, 'term_runtime_git')
  })

  it('matches runtime-owned folder and Git tabs by relay transport', async () => {
    const connectionId = 'runtime-relay'
    const folderHostId = toRuntimeExecutionHostId('folder-owner')
    const gitHostId = toRuntimeExecutionHostId('git-owner')
    const folder = makeFolderWorkspace('relay-folder', 'relay-group', connectionId, folderHostId)
    const folderKey = `folder:${folder.id}`
    const folderBinding = {
      ptyId: `ssh:${connectionId}@@folder-pty`,
      tabId: 'folder-tab',
      leafId: '88888888-8888-4888-8888-888888888888'
    }
    const gitBinding = {
      ptyId: `ssh:${connectionId}@@git-pty`,
      tabId: 'git-tab',
      leafId: '99999999-9999-4999-8999-999999999999'
    }
    const repo: Repo = {
      id: REPO_ID,
      path: '/workspace/duplicate-owner',
      displayName: 'Runtime Git',
      badgeColor: 'blue',
      connectionId,
      executionHostId: gitHostId,
      addedAt: 1
    }
    const { runtime } = createPartitionRuntime({
      repos: [repo],
      folders: [folder],
      groups: [makeProjectGroup(folder.projectGroupId, connectionId, folderHostId)],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [folderHostId, makeSession([folderBinding], folderKey)],
        [gitHostId, makeSession([gitBinding])]
      ])
    })
    const listProcesses = vi.fn(async () =>
      [
        [folderBinding, folderKey, folder.folderPath, 'term_relay_folder'],
        [gitBinding, WORKTREE_ID, repo.path, 'term_relay_git']
      ].map(([binding, worktreeId, cwd, terminalHandle]) => ({
        id: (binding as typeof folderBinding).ptyId,
        cwd: cwd as string,
        title: terminalHandle as string,
        worktreeId: worktreeId as string,
        terminalHandle: terminalHandle as string,
        incarnationId: INCARNATION_ID
      }))
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
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
      expect(new Set(events.map((snapshot) => snapshot.worktree))).toEqual(
        new Set([folderKey, WORKTREE_ID])
      )
    )
    expect(events.flatMap((snapshot) => snapshot.tabs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ready' }),
        expect.objectContaining({ status: 'ready' })
      ])
    )
    expect(listProcesses).toHaveBeenCalledWith(connectionId)
  })

  it('hydrates relay recovery from the indexed owner when repo ids span hosts', async () => {
    const connectionId = 'duplicate-relay-owner'
    const remoteWorktreeId = `${REPO_ID}::/remote/duplicate-owner`
    const binding = {
      ptyId: `ssh:${connectionId}@@duplicate-relay-pty`,
      tabId: 'duplicate-relay-tab',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }
    const wrongLocalBinding = {
      ptyId: `ssh:${connectionId}@@wrong-local-relay-pty`,
      tabId: 'wrong-local-relay-tab',
      leafId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    }
    const localRepo: Repo = {
      id: REPO_ID,
      path: '/workspace/duplicate-owner',
      displayName: 'Local duplicate',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const remoteRepo: Repo = {
      ...localRepo,
      path: '/remote/duplicate-owner',
      displayName: 'Remote duplicate',
      connectionId
    }
    const { runtime } = createPartitionRuntime({
      repos: [localRepo, remoteRepo],
      sessions: new Map([
        ['local', makeSession([wrongLocalBinding], remoteWorktreeId)],
        [toSshExecutionHostId(connectionId), makeSession([binding], remoteWorktreeId)]
      ])
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: binding.ptyId,
          cwd: remoteRepo.path,
          title: 'Remote duplicate',
          worktreeId: remoteWorktreeId,
          terminalHandle: 'term_duplicate_relay',
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
      expect(
        events.some((snapshot) =>
          snapshot.tabs.some(
            (tab) => tab.type === 'terminal' && tab.terminal === 'term_duplicate_relay'
          )
        )
      ).toBe(true)
    )
    expectExactSurface(runtime, binding, 'term_duplicate_relay')
    expect(events.at(-1)).toMatchObject({
      worktree: remoteWorktreeId,
      tabs: [{ parentTabId: binding.tabId, terminal: 'term_duplicate_relay' }]
    })
  })

  it('does not resurrect a folder deleted during relay inventory recovery', async () => {
    const connectionId = 'deleted-relay-folder'
    const folder = makeFolderWorkspace(
      'deleted-relay-folder',
      'deleted-relay-group',
      connectionId,
      null
    )
    const folderKey = `folder:${folder.id}`
    const binding = {
      ptyId: `ssh:${connectionId}@@deleted-folder-pty`,
      tabId: 'deleted-folder-tab',
      leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }
    const { runtime } = createPartitionRuntime({
      folders: [folder],
      groups: [makeProjectGroup(folder.projectGroupId, connectionId, null)],
      sessions: new Map([
        ['local', getDefaultWorkspaceSession()],
        [toSshExecutionHostId(connectionId), makeSession([binding], folderKey)]
      ])
    })
    const makeProcess = () => ({
      id: binding.ptyId,
      cwd: folder.folderPath,
      title: 'Deleted folder',
      worktreeId: folderKey,
      terminalHandle: 'term_deleted_folder',
      incarnationId: INCARNATION_ID
    })
    let releaseInventory!: (sessions: ReturnType<typeof makeProcess>[]) => void
    const inventory = new Promise<ReturnType<typeof makeProcess>[]>((resolve) => {
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
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    await expect(runtime.deleteFolderWorkspace(folder.id)).resolves.toEqual({
      deleted: true
    })
    releaseInventory([makeProcess()])
    await vi.waitFor(() =>
      expect(
        (
          runtime as unknown as {
            pendingMobileSessionPtyInventoryRefreshes: Map<string, unknown>
          }
        ).pendingMobileSessionPtyInventoryRefreshes.size
      ).toBe(0)
    )

    expect(events.at(-1)).toMatchObject({
      worktree: folderKey,
      removed: true,
      tabs: []
    })
    await expect(runtime.listMobileSessionTabs(`id:${folderKey}`)).resolves.toMatchObject({
      worktree: folderKey,
      removed: true,
      tabs: []
    })
    await expect(runtime.listAllMobileSessionTabs()).resolves.toMatchObject([
      { worktree: folderKey, removed: true, tabs: [] }
    ])
  })

  it('keeps targeted SSH lookup inside the targeted transport candidates', async () => {
    const connectionId = 'targeted-partition'
    const wrongRuntimeHost = toRuntimeExecutionHostId('wrong-local-owner')
    const binding = {
      ptyId: 'unprefixed-targeted-pty',
      tabId: 'targeted-tab',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    }
    const localRepo: Repo = {
      id: REPO_ID,
      path: '/workspace/duplicate-owner',
      displayName: 'Wrong exact local owner',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: wrongRuntimeHost,
      addedAt: 1
    }
    const remoteRepos = ['/remote/one', '/remote/two'].map(
      (path, index): Repo => ({
        ...localRepo,
        path,
        displayName: `Remote ${index}`,
        connectionId,
        executionHostId: null
      })
    )
    const { runtime } = createPartitionRuntime({
      repos: [localRepo, ...remoteRepos],
      sessions: new Map([
        [wrongRuntimeHost, getDefaultWorkspaceSession()],
        [toSshExecutionHostId(connectionId), makeSession([binding])]
      ])
    })
    const listProcesses = vi.fn(async () => [
      {
        id: binding.ptyId,
        cwd: localRepo.path,
        title: 'Targeted',
        worktreeId: WORKTREE_ID,
        terminalHandle: 'term_targeted_partition',
        incarnationId: INCARNATION_ID
      }
    ])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    await refreshInventory(runtime, connectionId)

    expectExactSurface(runtime, binding, 'term_targeted_partition')
    const internals = runtime as unknown as {
      ptysById: Map<string, { connected: boolean; connectionId: string | null }>
    }
    expect(internals.ptysById.get(binding.ptyId)).toMatchObject({
      connected: true,
      connectionId
    })

    listProcesses.mockResolvedValue([])
    await refreshInventory(runtime, connectionId)
    expect(internals.ptysById.get(binding.ptyId)?.connected).toBe(false)
  })

  it('reuses indexed sessions while preserving a large recovered folder snapshot', () => {
    const folder = makeFolderWorkspace('large-folder', 'large-group', null, null)
    const folderKey = `folder:${folder.id}`
    const bindings = Array.from({ length: 200 }, (_, index) => ({
      ptyId: `${folderKey}@@pty-${index}`,
      tabId: `tab-${index}`,
      leafId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
    }))
    const session = makeSession(bindings, folderKey)
    const harness = createPartitionRuntime({
      folders: [folder],
      groups: [makeProjectGroup(folder.projectGroupId, null, null)],
      sessions: new Map([['local', session]])
    })
    harness.runtime.attachWindow(1)
    harness.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: []
    })
    harness.getFolderWorkspaces.mockClear()
    harness.getProjectGroups.mockClear()
    harness.getWorkspaceSession.mockClear()
    harness.getWorkspaceSessionHostIds.mockClear()

    harness.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: []
    })

    const snapshots = (
      harness.runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, { tabs: unknown[] }>
      }
    ).mobileSessionTabsByWorktree
    expect(snapshots.get(folderKey)?.tabs).toHaveLength(200)
    expect(harness.getFolderWorkspaces).toHaveBeenCalledOnce()
    expect(harness.getWorkspaceSessionHostIds).toHaveBeenCalledOnce()
    expect(harness.getWorkspaceSession).toHaveBeenCalledOnce()
    expect(harness.getProjectGroups).toHaveBeenCalledOnce()
  })
})
