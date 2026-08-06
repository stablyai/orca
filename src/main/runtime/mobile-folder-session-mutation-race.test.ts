import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { FolderWorkspace, ProjectGroup, WorkspaceSessionState } from '../../shared/types'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
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
const PRIOR_TAB_ID = '44444444-4444-4444-8444-444444444444'
const PRIOR_LEAF_ID = '55555555-5555-4555-8555-555555555555'

function makeSession(worktreeId: string, ptyId = `${worktreeId}@@race-pty`): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: worktreeId,
    activeTabId: PRIOR_TAB_ID,
    activeTabIdByWorktree: { [worktreeId]: PRIOR_TAB_ID },
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
        },
        {
          id: PRIOR_TAB_ID,
          ptyId: 'serve-prior-folder-pty',
          worktreeId,
          title: 'Prior terminal',
          customTitle: null,
          color: null,
          sortOrder: 1,
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
      },
      [PRIOR_TAB_ID]: {
        root: { type: 'leaf', leafId: PRIOR_LEAF_ID },
        activeLeafId: PRIOR_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [PRIOR_LEAF_ID]: 'serve-prior-folder-pty' }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: '33333333-3333-4333-8333-333333333333'
    }
  }
}

function createRuntime(
  folders: FolderWorkspace[],
  group: ProjectGroup,
  ptyId?: string
): OrcaRuntimeService {
  let session = makeSession(`folder:${folders[0]!.id}`, ptyId)
  return new OrcaRuntimeService({
    getRepo: () => undefined,
    getRepos: () => [],
    getFolderWorkspaces: () => folders,
    getProjectGroups: () => [group],
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => ['local'],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
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
}

describe('mobile folder session mutation races', () => {
  it.each([
    ['navigation first', 'caller', 'host'],
    ['host focus first', 'host', 'caller']
  ] as const)(
    'reattaches once and honors host focus with %s',
    async (_order, firstNavigation, secondNavigation) => {
      const ptyId = 'serve-restarted-folder-pty'
      const folder: FolderWorkspace = {
        id: 'restored-folder',
        projectGroupId: 'restored-folder-group',
        name: 'Restored folder',
        folderPath: '/workspace/restored-folder',
        connectionId: null,
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
      const group: ProjectGroup = {
        id: folder.projectGroupId,
        name: folder.projectGroupId,
        parentPath: folder.folderPath,
        connectionId: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
      const folderKey = `folder:${folder.id}`
      const incarnationId = '33333333-3333-4333-8333-333333333333'
      const runtime = createRuntime([folder], group, ptyId)
      vi.spyOn(
        runtime as unknown as {
          resolveTerminalWorkspaceLaunchScope: () => Promise<{
            id: string
            path: string
            connectionId: null
            repo: null
            folderWorkspace: FolderWorkspace
          }>
        },
        'resolveTerminalWorkspaceLaunchScope'
      ).mockResolvedValue({
        id: folderKey,
        path: folder.folderPath,
        connectionId: null,
        repo: null,
        folderWorkspace: folder
      })
      let attached = false
      let releaseAttach!: () => void
      const attach = new Promise<void>((resolve) => {
        releaseAttach = resolve
      })
      const spawn = vi.fn(async () => {
        await attach
        attached = true
        return {
          id: ptyId,
          incarnationId,
          spawnDisposition: 'awaited' as const,
          spawnRetirementToken: 'live-runtime-waiter'
        }
      })
      const adoptSpawnReservation = vi.fn(() => true)
      const listProcesses = vi.fn(async () => [
        {
          id: ptyId,
          cwd: folder.folderPath,
          title: 'Restored folder terminal',
          worktreeId: folderKey,
          terminalHandle: 'term_restarted_folder',
          incarnationId
        }
      ])
      runtime.setPtyController({
        spawn,
        adoptSpawnReservation,
        write: () => attached,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses
      })

      const listed = await runtime.listMobileSessionTabs(`id:${folderKey}`)
      const listedTab = listed.tabs[0]
      expect(listedTab).toMatchObject({ status: 'ready', terminal: 'term_restarted_folder' })
      await expect(
        runtime.sendTerminal(listedTab?.type === 'terminal' ? listedTab.terminal! : 'missing', {
          text: 'before attach'
        })
      ).rejects.toThrow('terminal_not_writable')

      const pendingGet = vi.spyOn(runtime['pendingMobileTerminalMaterializations'], 'get')
      const firstActivation = runtime.activateMobileSessionTab(
        `id:${folderKey}`,
        TAB_ID,
        undefined,
        { navigation: firstNavigation }
      )
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      const secondActivation = runtime.activateMobileSessionTab(
        `id:${folderKey}`,
        TAB_ID,
        undefined,
        { navigation: secondNavigation }
      )
      await vi.waitFor(() => expect(pendingGet).toHaveBeenCalledTimes(2))
      releaseAttach()
      const activated = await Promise.all([firstActivation, secondActivation])
      const activatedTab = activated[0].tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === TAB_ID
      )
      expect(activated[1].tabs).toContainEqual(
        expect.objectContaining({ parentTabId: TAB_ID, status: 'ready' })
      )
      await expect(
        runtime.sendTerminal(
          activatedTab?.type === 'terminal' ? activatedTab.terminal! : 'missing',
          {
            text: 'folder input'
          }
        )
      ).resolves.toMatchObject({ accepted: true, bytesWritten: 12 })
      expect(spawn).toHaveBeenCalledOnce()
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: ptyId, worktreeId: folderKey })
      )
      expect(adoptSpawnReservation).toHaveBeenCalledExactlyOnceWith(ptyId, 'live-runtime-waiter')
      expect((await runtime.listMobileSessionTabs(`id:${folderKey}`)).activeTabId).toBe(
        `${TAB_ID}::${LEAF_ID}`
      )
    }
  )

  it('fences shared SSH reattachment when the reconnect generation changes', async () => {
    const connectionId = 'reattach-generation'
    const ptyId = `ssh:${connectionId}@@restored-pty`
    const folder: FolderWorkspace = {
      id: 'reconnect-folder',
      projectGroupId: 'reconnect-group',
      name: 'Reconnect folder',
      folderPath: '/workspace/reconnect-folder',
      connectionId,
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
    const group: ProjectGroup = {
      id: folder.projectGroupId,
      name: folder.projectGroupId,
      parentPath: folder.folderPath,
      connectionId: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const folderKey = `folder:${folder.id}`
    const runtime = createRuntime([folder], group, ptyId)
    const focusTerminal = vi.fn()
    const published: RuntimeMobileSessionTabsResult[] = []
    runtime.setNotifier({ focusTerminal } as never)
    runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
    vi.spyOn(
      runtime as unknown as {
        resolveTerminalWorkspaceLaunchScope: () => Promise<{
          id: string
          path: string
          connectionId: string
          repo: null
          folderWorkspace: FolderWorkspace
        }>
      },
      'resolveTerminalWorkspaceLaunchScope'
    ).mockResolvedValue({
      id: folderKey,
      path: folder.folderPath,
      connectionId,
      repo: null,
      folderWorkspace: folder
    })
    let releaseSpawn!: () => void
    const pendingSpawn = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const spawn = vi.fn(async () => {
      await pendingSpawn
      return { id: ptyId, spawnDisposition: 'reattached' as const }
    })
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })

    const activations = Promise.allSettled([
      runtime.activateMobileSessionTab(`id:${folderKey}`, TAB_ID),
      runtime.activateMobileSessionTab(`id:${folderKey}`, TAB_ID)
    ])
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    runtime.notifySshStateChanged(connectionId, {
      targetId: connectionId,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })
    releaseSpawn()

    const results = await activations
    expect(results).toHaveLength(2)
    results.forEach((result) => {
      expect(result).toMatchObject({ status: 'rejected' })
      expect(result.status === 'rejected' ? result.reason : null).toMatchObject({
        message: 'tab_not_found'
      })
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(published).not.toContainEqual(
      expect.objectContaining({ activeTabId: `${TAB_ID}::${LEAF_ID}` })
    )
  })

  it.each(['activate', 'close'] as const)(
    'rejects a folder tab %s when deletion races PTY inventory',
    async (operation) => {
      const folder: FolderWorkspace = {
        id: `${operation}-race-folder`,
        projectGroupId: `${operation}-race-group`,
        name: `${operation} race`,
        folderPath: `/workspace/${operation}-race`,
        connectionId: null,
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
      const group: ProjectGroup = {
        id: folder.projectGroupId,
        name: folder.projectGroupId,
        parentPath: folder.folderPath,
        connectionId: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
      const folderKey = `folder:${folder.id}`
      const folders = [folder]
      const runtime = createRuntime(folders, group)
      await runtime.listMobileSessionTabs(`id:${folderKey}`)
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

      const mutation =
        operation === 'activate'
          ? runtime.activateMobileSessionTab(`id:${folderKey}`, TAB_ID)
          : runtime.closeMobileSessionTab(`id:${folderKey}`, TAB_ID)
      await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledOnce())
      folders.length = 0
      releaseInventory([])

      await expect(mutation).rejects.toThrow('tab_not_found')
      await expect(runtime.listMobileSessionTabs(`id:${folderKey}`)).resolves.toMatchObject({
        worktree: folderKey,
        removed: true,
        tabs: []
      })
    }
  )

  it.each([
    ['creator-only', 'created', undefined, undefined, true],
    ['shared creator', 'created', 'creator-token', false, false],
    ['shared waiter', 'awaited', 'waiter-token', false, false],
    ['reattach consumer', 'reattached', undefined, undefined, false]
  ] as const)(
    'retires a stale %s materialization without harming a live reservation peer',
    async (_consumer, spawnDisposition, spawnRetirementToken, releaseResult, shouldKill) => {
      const folder: FolderWorkspace = {
        id: 'materialize-race-folder',
        projectGroupId: 'materialize-race-group',
        name: 'Materialize race',
        folderPath: '/workspace/materialize-race',
        connectionId: null,
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
      const group: ProjectGroup = {
        id: folder.projectGroupId,
        name: folder.projectGroupId,
        parentPath: folder.folderPath,
        connectionId: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
      const folderKey = `folder:${folder.id}`
      const folders = [folder]
      const runtime = createRuntime(folders, group)
      const focusTerminal = vi.fn()
      const published: RuntimeMobileSessionTabsResult[] = []
      runtime.setNotifier({ focusTerminal } as never)
      runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
      vi.spyOn(
        runtime as unknown as {
          resolveTerminalWorkspaceLaunchScope: () => Promise<{
            id: string
            path: string
            connectionId: null
            repo: null
            folderWorkspace: FolderWorkspace
          }>
        },
        'resolveTerminalWorkspaceLaunchScope'
      ).mockImplementation(async () => ({
        id: folderKey,
        path: folder.folderPath,
        connectionId: null,
        repo: null,
        folderWorkspace: folder
      }))
      let releaseSpawn!: (value: {
        id: string
        spawnDisposition: typeof spawnDisposition
        spawnRetirementToken?: string
      }) => void
      const spawn = vi.fn(
        () =>
          new Promise<{
            id: string
            spawnDisposition: typeof spawnDisposition
            spawnRetirementToken?: string
          }>((resolve) => {
            releaseSpawn = resolve
          })
      )
      const kill = vi.fn(() => true)
      const releaseSpawnReservation = vi.fn(() => releaseResult ?? false)
      runtime.setPtyController({
        write: () => true,
        kill,
        releaseSpawnReservation,
        getForegroundProcess: async () => null,
        listProcesses: async () => [],
        spawn
      })

      const activations = Promise.allSettled([
        runtime.activateMobileSessionTab(`id:${folderKey}`, TAB_ID),
        runtime.activateMobileSessionTab(`id:${folderKey}`, TAB_ID)
      ])
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      folders.length = 0
      folders.push({ ...folder, folderPath: '/workspace/materialize-race-moved' })
      releaseSpawn({
        id: 'stale-materialized-pty',
        spawnDisposition,
        ...(spawnRetirementToken ? { spawnRetirementToken } : {})
      })

      const results = await activations
      results.forEach((result) => {
        expect(result.status === 'rejected' ? result.reason : null).toMatchObject({
          message: 'tab_not_found'
        })
      })
      expect(spawn).toHaveBeenCalledOnce()
      if (shouldKill) {
        expect(kill).toHaveBeenCalledWith('stale-materialized-pty')
      } else {
        expect(kill).not.toHaveBeenCalled()
      }
      if (spawnRetirementToken) {
        expect(releaseSpawnReservation).toHaveBeenCalledWith(
          'stale-materialized-pty',
          spawnRetirementToken
        )
      } else {
        expect(releaseSpawnReservation).not.toHaveBeenCalled()
      }
      expect(focusTerminal).not.toHaveBeenCalled()
      expect(published).not.toContainEqual(
        expect.objectContaining({ activeTabId: `${TAB_ID}::${LEAF_ID}` })
      )
    }
  )
})
