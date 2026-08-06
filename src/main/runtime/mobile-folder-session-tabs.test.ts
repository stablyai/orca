import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { FolderWorkspace, ProjectGroup, WorkspaceSessionState } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'

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

const FOLDER_ID = '2573f8cc-8e3a-4e16-bf2b-95f8bae2eb1d'
const FOLDER_KEY = `folder:${FOLDER_ID}`
const TAB_ID = '7c6174e8-ab60-4fce-8e81-d68869972347'
const LEAF_ID = 'f822e244-4950-418c-b690-aca1e9aa669f'
const PROVIDER_SESSION_ID = '019fb802-68c6-7400-a38e-6afcc8d2690e'
const PTY_INCARNATION_ID = '68686868-6868-4868-8868-686868686868'
const FOLDER_PATH = '/workspace/folder-project'

const baseRepo = {
  id: 'repo-control',
  path: '/workspace/control',
  displayName: 'control',
  badgeColor: 'blue',
  addedAt: 1
}

function makeFolderWorkspace(connectionId: string | null = null): FolderWorkspace {
  return {
    id: FOLDER_ID,
    projectGroupId: 'folder-group',
    name: 'Folder QA',
    folderPath: FOLDER_PATH,
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorkspaceSession(ptyId: string, workspaceId = FOLDER_KEY): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: workspaceId,
    activeTabId: TAB_ID,
    activeTabIdByWorktree: { [workspaceId]: TAB_ID },
    tabsByWorktree: {
      [workspaceId]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId: workspaceId,
          title: 'PR11751 Folder Grok QA',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'grok'
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
      [makePaneKey(TAB_ID, LEAF_ID)]: PTY_INCARNATION_ID
    }
  }
}

function createRuntime(args: {
  connectionId?: string | null
  projectGroupConnectionId?: string | null
  executionHostId?: ExecutionHostId | null
  projectGroupExecutionHostId?: ExecutionHostId | null
  ptyId: string
  workspaceId?: string
}) {
  const connectionId = args.connectionId ?? args.projectGroupConnectionId ?? null
  const workspaceId = args.workspaceId ?? FOLDER_KEY
  const hostId =
    args.executionHostId ??
    args.projectGroupExecutionHostId ??
    (connectionId ? toSshExecutionHostId(connectionId) : 'local')
  let folderIncluded = true
  const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
    ['local', getDefaultWorkspaceSession()],
    [hostId, makeWorkspaceSession(args.ptyId, workspaceId)]
  ])
  const folder = makeFolderWorkspace(args.connectionId ?? null)
  folder.executionHostId = args.executionHostId ?? null
  const projectGroup: ProjectGroup = {
    id: folder.projectGroupId,
    name: 'Folder group',
    parentPath: FOLDER_PATH,
    connectionId: args.projectGroupConnectionId ?? null,
    executionHostId: args.projectGroupExecutionHostId ?? null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const getWorkspaceSession = vi.fn(
    (requestedHostId?: string | null) =>
      sessions.get((requestedHostId ?? 'local') as ExecutionHostId) ?? sessions.get('local')!
  )
  const runtime = new OrcaRuntimeService(
    {
      getRepo: (id: string) => (id === baseRepo.id ? baseRepo : undefined),
      getRepos: () => [baseRepo],
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getFolderWorkspaces: () => (workspaceId === FOLDER_KEY && folderIncluded ? [folder] : []),
      getProjectGroups: vi.fn(() => [projectGroup]),
      removeFolderWorkspace: () => {
        if (!folderIncluded) {
          return false
        }
        folderIncluded = false
        return true
      },
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getGitHubCache: () => ({ pr: {}, issue: {} }),
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getWorkspaceSession,
      getWorkspaceSessionHostIds: vi.fn(() => [...sessions.keys()]),
      getSettings: () => ({
        workspaceDir: '/workspace',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      })
    },
    undefined,
    {
      getAgentProviderSessionRowsForPane: (paneKey) =>
        paneKey === makePaneKey(TAB_ID, LEAF_ID)
          ? [
              {
                paneKey,
                state: 'done',
                prompt: 'For exact-head mobile QA, reply with exactly FOLDER-GROK-READY.',
                agentType: 'grok',
                connectionId,
                receivedAt: Date.now(),
                stateStartedAt: Date.now(),
                tabId: TAB_ID,
                worktreeId: workspaceId,
                providerSession: { key: 'session_id', id: PROVIDER_SESSION_ID }
              }
            ]
          : []
    }
  )
  const listProcesses = vi.fn(async () => [
    {
      id: args.ptyId,
      cwd: workspaceId === FOLDER_KEY ? FOLDER_PATH : baseRepo.path,
      title: 'Grok',
      worktreeId: workspaceId,
      terminalHandle: `term_${args.ptyId.replaceAll(/[^a-zA-Z0-9]/g, '_')}`,
      incarnationId: PTY_INCARNATION_ID
    }
  ])
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'grok',
    listProcesses
  })
  return {
    runtime,
    getWorkspaceSession,
    listProcesses,
    removeFolder: () => {
      folderIncluded = false
    },
    restoreFolder: () => {
      folderIncluded = true
    },
    getOwningWorkspaceSession: () => sessions.get(hostId)!,
    removeFolderTabs: () => {
      const session = sessions.get(hostId)!
      session.tabsByWorktree = {}
      session.terminalLayoutsByTabId = {}
    }
  }
}

function publishGraphWithoutFolderSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  windowId = 1
): void {
  runtime.attachWindow(windowId)
  runtime.syncWindowGraph(windowId, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: FOLDER_KEY,
        title: 'PR11751 Folder Grok QA',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: FOLDER_KEY,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId,
        paneTitle: 'Grok'
      }
    ],
    mobileSessionTabs: []
  })
}

function stallRelayRecoveryFollowUp(runtime: OrcaRuntimeService): void {
  vi.spyOn(
    runtime as unknown as { refreshRestoredOrchestrationAuthority: () => Promise<void> },
    'refreshRestoredOrchestrationAuthority'
  ).mockResolvedValue()
  vi.spyOn(runtime, 'reconcileLegacyWorkerTerminals').mockReturnValue(new Promise(() => undefined))
}

function expectUsableGrokSnapshot(
  snapshot: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>,
  workspaceId = FOLDER_KEY,
  terminalHandle?: string
) {
  expect(snapshot).toMatchObject({
    worktree: workspaceId,
    tabs: [
      {
        type: 'terminal',
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        status: 'ready',
        terminal: terminalHandle ?? expect.stringMatching(/^term_/),
        agentStatus: {
          agentType: 'grok',
          providerSession: { id: PROVIDER_SESSION_ID }
        }
      }
    ]
  })
}

describe('mobile folder session tabs', () => {
  it('recovers a usable local folder snapshot when the attached renderer omits its mobile entry', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)

    const snapshot = await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)

    expectUsableGrokSnapshot(snapshot)
  })

  it('uses the same recovered list result for the initial mobile subscription snapshot', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime } = createRuntime({ ptyId })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: SESSION_TAB_METHODS
    })
    const messages: string[] = []
    publishGraphWithoutFolderSnapshot(runtime, ptyId)

    await dispatcher.dispatchStreaming(
      {
        id: 'folder-subscription',
        authToken: 'token',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${FOLDER_KEY}` }
      },
      (message) => messages.push(message),
      { connectionId: 'paired-mobile' }
    )

    expect(messages).toHaveLength(1)
    expectUsableGrokSnapshot(JSON.parse(messages[0]!).result)
  })

  it('includes a recovered local folder in the aggregate session snapshot', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)

    const snapshots = await runtime.listAllMobileSessionTabs()

    expectUsableGrokSnapshot(snapshots.find((snapshot) => snapshot.worktree === FOLDER_KEY)!)
  })

  it('fully recovers an omitted folder containing ordinary and runtime-owned terminals', async () => {
    const ordinaryPtyId = `${FOLDER_KEY}@@ordinary`
    const servePtyId = 'serve-folder-runtime-owned'
    const serveTabId = '11111111-1111-4111-8111-111111111111'
    const serveLeafId = '22222222-2222-4222-8222-222222222222'
    const { runtime, getOwningWorkspaceSession, listProcesses } = createRuntime({
      ptyId: ordinaryPtyId
    })
    const session = getOwningWorkspaceSession()
    session.tabsByWorktree[FOLDER_KEY]!.push({
      id: serveTabId,
      ptyId: servePtyId,
      worktreeId: FOLDER_KEY,
      title: 'Runtime-owned terminal',
      customTitle: null,
      color: null,
      sortOrder: 1,
      createdAt: 2
    })
    session.terminalLayoutsByTabId[serveTabId] = {
      root: { type: 'leaf', leafId: serveLeafId },
      activeLeafId: serveLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [serveLeafId]: servePtyId }
    }
    session.terminalPtyIncarnationsByPaneKey![makePaneKey(serveTabId, serveLeafId)] =
      '77777777-7777-4777-8777-777777777777'
    listProcesses.mockResolvedValue([
      {
        id: ordinaryPtyId,
        cwd: FOLDER_PATH,
        title: 'Grok',
        worktreeId: FOLDER_KEY,
        terminalHandle: 'term_ordinary',
        incarnationId: PTY_INCARNATION_ID
      },
      {
        id: servePtyId,
        cwd: FOLDER_PATH,
        title: 'Runtime-owned terminal',
        worktreeId: FOLDER_KEY,
        terminalHandle: 'term_runtime_owned',
        incarnationId: '77777777-7777-4777-8777-777777777777'
      }
    ])
    publishGraphWithoutFolderSnapshot(runtime, ordinaryPtyId)

    const snapshot = await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)

    expect(snapshot.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: TAB_ID,
          terminal: 'term_ordinary'
        }),
        expect.objectContaining({
          parentTabId: serveTabId,
          terminal: 'term_runtime_owned'
        })
      ])
    )
    expect(snapshot.tabs).toHaveLength(2)
  })

  it('fully recovers a pre-attach partial folder only when persisted surfaces change', async () => {
    const ordinaryPtyId = `${FOLDER_KEY}@@ordinary`
    const servePtyId = 'serve-folder-pre-attach'
    const serveTabId = '33333333-3333-4333-8333-333333333333'
    const serveLeafId = '44444444-4444-4444-8444-444444444444'
    const { runtime, getOwningWorkspaceSession, listProcesses } = createRuntime({
      ptyId: ordinaryPtyId
    })
    const session = getOwningWorkspaceSession()
    session.tabsByWorktree[FOLDER_KEY]!.push({
      id: serveTabId,
      ptyId: servePtyId,
      worktreeId: FOLDER_KEY,
      title: 'Runtime-owned terminal',
      customTitle: null,
      color: null,
      sortOrder: 1,
      createdAt: 2
    })
    session.terminalLayoutsByTabId[serveTabId] = {
      root: { type: 'leaf', leafId: serveLeafId },
      activeLeafId: serveLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [serveLeafId]: servePtyId }
    }
    const internals = runtime as unknown as {
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
        worktreeId: string,
        options: Record<string, boolean>
      ) => Set<string>
      mobileSessionTabsByWorktree: Map<string, { tabs: { parentTabId?: string }[] }>
    }
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(FOLDER_KEY, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(internals.mobileSessionTabsByWorktree.get(FOLDER_KEY)?.tabs).toMatchObject([
      { parentTabId: serveTabId }
    ])
    const hydrate = vi.spyOn(internals, 'hydrateHeadlessMobileSessionTabsFromWorkspaceSession')
    listProcesses.mockResolvedValue([
      {
        id: ordinaryPtyId,
        cwd: FOLDER_PATH,
        title: 'Ordinary',
        worktreeId: FOLDER_KEY,
        terminalHandle: 'term_pre_attach_ordinary',
        incarnationId: PTY_INCARNATION_ID
      },
      {
        id: servePtyId,
        cwd: FOLDER_PATH,
        title: 'Runtime',
        worktreeId: FOLDER_KEY,
        terminalHandle: 'term_pre_attach_runtime',
        incarnationId: '88888888-8888-4888-8888-888888888888'
      }
    ])

    publishGraphWithoutFolderSnapshot(runtime, ordinaryPtyId)
    expect((await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)).tabs).toHaveLength(2)

    session.tabsByWorktree[FOLDER_KEY] = session.tabsByWorktree[FOLDER_KEY]!.filter(
      (tab) => tab.id !== TAB_ID
    )
    delete session.terminalLayoutsByTabId[TAB_ID]
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const snapshot = await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)

    expect(snapshot.tabs).toMatchObject([{ parentTabId: serveTabId }])
    expect(hydrate.mock.calls.filter(([, options]) => options?.force === true)).toHaveLength(2)
    runtime.markGraphUnavailable(1)
    publishGraphWithoutFolderSnapshot(runtime, servePtyId, 2)
    await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)
    expect(hydrate.mock.calls.filter(([, options]) => options?.force === true)).toHaveLength(3)
  })

  it('coalesces concurrent PTY inventory reads after the folder snapshot settles', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime, getWorkspaceSession, listProcesses } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)
    await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)
    getWorkspaceSession.mockClear()
    listProcesses.mockClear()

    const snapshots = await Promise.all([
      runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`),
      runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)
    ])

    snapshots.forEach((snapshot) => expectUsableGrokSnapshot(snapshot))
    expect(getWorkspaceSession).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledOnce()
  })

  it('preserves the renderer-owned Git worktree snapshot path', async () => {
    const workspaceId = `${baseRepo.id}::${baseRepo.path}`
    const ptyId = 'git-worktree-pty'
    const { runtime } = createRuntime({ ptyId, workspaceId })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: workspaceId,
          title: 'Git worktree Grok',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: workspaceId,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId,
          paneTitle: 'Grok'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: workspaceId,
          publicationEpoch: 'renderer-git-control',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `${TAB_ID}::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${TAB_ID}::${LEAF_ID}`,
              title: 'Git worktree Grok',
              parentTabId: TAB_ID,
              leafId: LEAF_ID,
              ptyId,
              isActive: true
            }
          ]
        }
      ]
    })

    const snapshot = await runtime.listMobileSessionTabs(`id:${workspaceId}`)

    expect(snapshot).toMatchObject({
      worktree: workspaceId,
      publicationEpoch: 'renderer-git-control',
      tabs: [
        {
          type: 'terminal',
          parentTabId: TAB_ID,
          leafId: LEAF_ID,
          status: 'ready',
          terminal: expect.stringMatching(/^term_/)
        }
      ]
    })
  })

  it.each(['ssh-folder', 'runtime-ssh-folder'])(
    'hydrates %s folder identity from its owning session partition',
    async (connectionId) => {
      const ptyId = `ssh:${connectionId}@@remote-folder-pty`
      const { runtime, getWorkspaceSession } = createRuntime({ connectionId, ptyId })
      publishGraphWithoutFolderSnapshot(runtime, ptyId)

      const snapshots = await runtime.listAllMobileSessionTabs()

      const folderSnapshot = snapshots.find((snapshot) => snapshot.worktree === FOLDER_KEY)
      expect(folderSnapshot).toBeDefined()
      expectUsableGrokSnapshot(folderSnapshot!)
      expect(getWorkspaceSession).toHaveBeenCalledWith(toSshExecutionHostId(connectionId))
    }
  )

  it('hydrates an SSH folder routed by its project group', async () => {
    const connectionId = 'project-group-ssh-folder'
    const ptyId = `ssh:${connectionId}@@remote-folder-pty`
    const { runtime, getWorkspaceSession } = createRuntime({
      projectGroupConnectionId: connectionId,
      ptyId
    })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)

    const snapshots = await runtime.listAllMobileSessionTabs()

    expectUsableGrokSnapshot(snapshots.find((snapshot) => snapshot.worktree === FOLDER_KEY)!)
    expect(getWorkspaceSession).toHaveBeenCalledWith(toSshExecutionHostId(connectionId))
  })

  it.each([
    [
      'workspace',
      { executionHostId: toRuntimeExecutionHostId('folder-runtime') },
      toRuntimeExecutionHostId('folder-runtime')
    ],
    [
      'project group',
      {
        projectGroupExecutionHostId: toRuntimeExecutionHostId('group-runtime')
      },
      toRuntimeExecutionHostId('group-runtime')
    ]
  ])('recovers a headless folder from its %s runtime host', async (_source, owner, hostId) => {
    const ptyId = 'runtime-folder-pty'
    const { runtime, getWorkspaceSession } = createRuntime({ ...owner, ptyId })
    const terminalHandle = 'term_runtime_folder_pty'

    const snapshots = await runtime.listAllMobileSessionTabs()

    expectUsableGrokSnapshot(
      snapshots.find((snapshot) => snapshot.worktree === FOLDER_KEY)!,
      FOLDER_KEY,
      terminalHandle
    )
    expect(getWorkspaceSession).toHaveBeenCalledWith(hostId)
    expect(
      (
        runtime as unknown as {
          restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
        }
      ).restoredOrchestrationAuthorityByPtyId.has(ptyId)
    ).toBe(true)
  })

  it('removes an already-recovered folder after its workspace is deleted', async () => {
    const ptyId = `serve-folder-pty`
    const { runtime, removeFolder } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)
    await expect(runtime.listAllMobileSessionTabs()).resolves.toHaveLength(1)

    removeFolder()
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    await expect(runtime.listAllMobileSessionTabs()).resolves.toMatchObject([
      { worktree: FOLDER_KEY, removed: true, tabs: [] }
    ])
  })

  it('does not resurrect a recovered local folder tab after persistence removes it', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime, removeFolderTabs } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)
    await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)

    removeFolderTabs()

    const snapshot = await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)

    expect(snapshot).toMatchObject({
      worktree: FOLDER_KEY,
      tabs: []
    })
    expect(snapshot).not.toHaveProperty('removed')
    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
  })

  it('publishes and retains a removal tombstone for explicit reconnects', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime } = createRuntime({ ptyId })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: SESSION_TAB_METHODS
    })
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    const messages: string[] = []
    publishGraphWithoutFolderSnapshot(runtime, ptyId)
    await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await expect(runtime.deleteFolderWorkspace(FOLDER_ID)).resolves.toEqual({
      deleted: true
    })

    expect(events).toMatchObject([{ worktree: FOLDER_KEY, removed: true, tabs: [] }])
    await expect(runtime.listAllMobileSessionTabs()).resolves.toMatchObject([
      { worktree: FOLDER_KEY, removed: true, tabs: [] }
    ])
    await dispatcher.dispatchStreaming(
      {
        id: 'removed-folder-subscription',
        authToken: 'token',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${FOLDER_KEY}` }
      },
      (message) => messages.push(message),
      { connectionId: 'paired-web' }
    )
    expect(JSON.parse(messages[0]!).result).toMatchObject({
      type: 'snapshot',
      worktree: FOLDER_KEY,
      removed: true,
      tabs: []
    })
  })

  it('does not let an older tombstone override a recreated live folder snapshot', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime, restoreFolder } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)
    await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
    }
    const live = internals.mobileSessionTabsByWorktree.get(FOLDER_KEY)!

    await runtime.deleteFolderWorkspace(FOLDER_ID)
    restoreFolder()
    internals.mobileSessionTabsByWorktree.set(FOLDER_KEY, live)

    const [snapshot] = await runtime.listAllMobileSessionTabs()

    expectUsableGrokSnapshot(snapshot!)
    expectUsableGrokSnapshot(events.at(-1)!)
  })

  it('clears a deletion tombstone when the same folder identity is recreated empty', async () => {
    const ptyId = `${FOLDER_KEY}@@311a9e66`
    const { runtime, restoreFolder, removeFolderTabs } = createRuntime({ ptyId })
    publishGraphWithoutFolderSnapshot(runtime, ptyId)
    await runtime.listMobileSessionTabs(`id:${FOLDER_KEY}`)

    await runtime.deleteFolderWorkspace(FOLDER_ID)
    removeFolderTabs()
    restoreFolder()

    await expect(runtime.listAllMobileSessionTabs()).resolves.toEqual([])
  })

  it('does not publish folder recovery after its SSH relay generation goes stale', async () => {
    const connectionId = 'ssh-stale-folder'
    const ptyId = `ssh:${connectionId}@@remote-folder-pty`
    const { runtime, listProcesses } = createRuntime({ connectionId, ptyId })
    let releaseResolution!: (value: []) => void
    const resolution = new Promise<[]>((resolve) => {
      releaseResolution = resolve
    })
    const listResolvedWorktrees = vi
      .spyOn(
        runtime as unknown as { listResolvedWorktrees: () => Promise<[]> },
        'listResolvedWorktrees'
      )
      .mockReturnValueOnce(resolution)
    listProcesses.mockClear()
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    stallRelayRecoveryFollowUp(runtime)

    runtime.notifySshRelayReady(connectionId)
    await vi.waitFor(() => expect(listResolvedWorktrees).toHaveBeenCalledOnce())
    runtime.notifySshStateChanged(connectionId, {
      targetId: connectionId,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })
    releaseResolution([])
    await vi.waitFor(() =>
      expect(
        (
          runtime as unknown as {
            pendingMobileSessionPtyInventoryRefreshes: Map<string, unknown>
          }
        ).pendingMobileSessionPtyInventoryRefreshes.size
      ).toBe(0)
    )

    expect(events).toEqual([])
    expect(listProcesses).not.toHaveBeenCalled()
    expect(
      (
        runtime as unknown as {
          mobileSessionTabsByWorktree: Map<string, unknown>
        }
      ).mobileSessionTabsByWorktree.has(FOLDER_KEY)
    ).toBe(false)
    expect(
      (
        runtime as unknown as {
          ptysById: Map<string, unknown>
        }
      ).ptysById.has(ptyId)
    ).toBe(false)
  })

  it('retries an older generation rejected by a newer relay-ready publication', async () => {
    const connectionId = 'ssh-overlapping-ready-folder'
    const ptyId = `ssh:${connectionId}@@remote-folder-pty`
    const { runtime, listProcesses } = createRuntime({ connectionId, ptyId })
    let releaseOlderInventory!: (value: []) => void
    let releaseCurrentInventory!: (value: Awaited<ReturnType<typeof listProcesses>>) => void
    const olderInventory = new Promise<[]>((resolve) => {
      releaseOlderInventory = resolve
    })
    const currentInventory = new Promise<Awaited<ReturnType<typeof listProcesses>>>((resolve) => {
      releaseCurrentInventory = resolve
    })
    listProcesses.mockReset()
    listProcesses.mockReturnValueOnce(olderInventory).mockReturnValueOnce(currentInventory)
    stallRelayRecoveryFollowUp(runtime)
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.notifySshRelayReady(connectionId)
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
    runtime.notifySshRelayReady(connectionId)
    releaseOlderInventory([])
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(2))

    expect(events).toEqual([])
    releaseCurrentInventory([
      {
        id: ptyId,
        cwd: FOLDER_PATH,
        title: 'Grok',
        worktreeId: FOLDER_KEY,
        terminalHandle: 'term_current_generation',
        incarnationId: PTY_INCARNATION_ID
      }
    ])
    await vi.waitFor(() => expect(events).toHaveLength(1))

    expectUsableGrokSnapshot(events[0]!, FOLDER_KEY, 'term_current_generation')
  })

  it('starts a fresh inventory when relay-ready joins a successful pre-ready refresh', async () => {
    const connectionId = 'ssh-pre-ready-inventory'
    const ptyId = `ssh:${connectionId}@@remote-folder-pty`
    const { runtime, listProcesses } = createRuntime({ connectionId, ptyId })
    let releasePreReady!: (value: []) => void
    let releasePostReady!: (value: Awaited<ReturnType<typeof listProcesses>>) => void
    const preReadyInventory = new Promise<[]>((resolve) => {
      releasePreReady = resolve
    })
    const postReadyInventory = new Promise<Awaited<ReturnType<typeof listProcesses>>>((resolve) => {
      releasePostReady = resolve
    })
    listProcesses.mockReset()
    listProcesses.mockReturnValueOnce(preReadyInventory).mockReturnValueOnce(postReadyInventory)
    stallRelayRecoveryFollowUp(runtime)
    const events: Awaited<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>>[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const preReadyRefresh = (
      runtime as unknown as {
        refreshMobileSessionPtyRecords: () => Promise<Set<string> | null>
      }
    ).refreshMobileSessionPtyRecords()
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())

    runtime.notifySshRelayReady(connectionId)
    releasePreReady([])
    await preReadyRefresh
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(2))

    expect(events).toEqual([])
    releasePostReady([
      {
        id: ptyId,
        cwd: FOLDER_PATH,
        title: 'Grok',
        worktreeId: FOLDER_KEY,
        terminalHandle: 'term_post_ready_inventory',
        incarnationId: PTY_INCARNATION_ID
      }
    ])
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expectUsableGrokSnapshot(events[0]!, FOLDER_KEY, 'term_post_ready_inventory')
  })
})
