import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { FolderWorkspace, ProjectGroup, Repo, WorkspaceSessionState } from '../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
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

const REPO_ID = 'folder-host-owner-repo'
const CONNECTION_ID = 'folder-host-owner-relay'
const INCARNATION_ID = '09090909-0909-4909-8909-090909090909'

function makeSession(args: {
  worktreeId: string
  ptyId: string
  tabId: string
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
      root: { type: 'leaf', leafId: INCARNATION_ID },
      activeLeafId: INCARNATION_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [INCARNATION_ID]: args.ptyId }
    }
  }
  session.terminalPtyIncarnationsByPaneKey = {
    [makePaneKey(args.tabId, INCARNATION_ID)]: INCARNATION_ID
  }
  return session
}

function makeFolder(executionHostId: ExecutionHostId): FolderWorkspace {
  return {
    id: 'moved-folder',
    projectGroupId: 'moved-folder-group',
    name: 'Moved folder',
    folderPath: '/remote/moved-folder',
    connectionId: CONNECTION_ID,
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

function makeGroup(executionHostId: ExecutionHostId): ProjectGroup {
  return {
    id: 'moved-folder-group',
    name: 'Moved folder group',
    parentPath: '/remote/moved-folder',
    connectionId: CONNECTION_ID,
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

describe('mobile folder host ownership', () => {
  it('does not treat a missing optional folder catalog as authoritative emptiness', async () => {
    const runtime = new OrcaRuntimeService({
      removeFolderWorkspace: () => true,
      deleteProjectGroup: () => true
    } as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
    }
    const snapshot = {
      worktree: 'folder:partial-store',
      publicationEpoch: 'headless-hydrated:partial-store',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    internals.mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)

    await expect(runtime.deleteFolderWorkspace('partial-store')).resolves.toEqual({ deleted: true })
    await expect(runtime.deleteProjectGroup('partial-store-group')).resolves.toEqual({
      deleted: true
    })

    expect(internals.mobileSessionTabsByWorktree.get(snapshot.worktree)).toBe(snapshot)
  })

  it('does not let one ambiguous PTY prevent a desktop window from attaching', () => {
    const worktreeId = `${REPO_ID}::/worktrees/ambiguous-feature`
    const ptyId = 'ambiguous-attach-pty'
    const tabId = 'ambiguous-attach-tab'
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      ['local', makeSession({ worktreeId, ptyId, tabId })],
      [toSshExecutionHostId(CONNECTION_ID), makeSession({ worktreeId, ptyId, tabId })]
    ])
    const localRepo: Repo = {
      id: REPO_ID,
      path: '/workspace/local-root',
      displayName: 'Local root',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService({
      getRepos: () => [
        localRepo,
        {
          ...localRepo,
          path: '/remote/root',
          displayName: 'Remote root',
          connectionId: CONNECTION_ID
        }
      ],
      getWorkspaceSession: (hostId?: string | null) =>
        sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorktreeMeta: () => undefined,
      setWorkspaceSession
    } as never)
    const internals = runtime as unknown as {
      authoritativeWindowId: number | null
      recordPtyWorktree: (
        id: string,
        owner: string,
        state: { connected: true; tabId: string }
      ) => void
    }
    internals.recordPtyWorktree(ptyId, worktreeId, { connected: true, tabId })

    expect(() => runtime.attachWindow(91)).not.toThrow()
    expect(internals.authoritativeWindowId).toBe(91)
    expect(setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('persists a live raw Git PTY through its scoped owner on desktop attach', () => {
    const worktreeId = `${REPO_ID}::/worktrees/scoped-feature`
    const workspaceKey = worktreeWorkspaceKey(worktreeId)
    const ptyId = 'scoped-attach-pty'
    const tabId = 'scoped-attach-tab'
    const session = makeSession({ worktreeId: workspaceKey, ptyId, tabId })
    const repo: Repo = {
      id: REPO_ID,
      path: '/workspace/repo',
      displayName: 'Local repo',
      badgeColor: 'blue',
      connectionId: null,
      addedAt: 1
    }
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService({
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local'],
      getWorktreeMeta: () => undefined,
      setWorkspaceSession
    } as never)
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        id: string,
        owner: string,
        state: { connected: true; tabId: string }
      ) => void
    }
    internals.recordPtyWorktree(ptyId, worktreeId, { connected: true, tabId })

    runtime.attachWindow(92)

    expect(setWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorktreeIdsOnShutdown: [worktreeId] }),
      'local'
    )
  })

  it('normalizes a scoped Git selector to the raw mobile snapshot owner', async () => {
    const worktreeId = `${REPO_ID}::/worktrees/scoped-selector`
    const workspaceKey = worktreeWorkspaceKey(worktreeId)
    const session = makeSession({
      worktreeId: workspaceKey,
      ptyId: 'scoped-selector-pty',
      tabId: 'scoped-selector-tab'
    })
    const repo: Repo = {
      id: REPO_ID,
      path: '/workspace/repo',
      displayName: 'Scoped selector repo',
      badgeColor: 'blue',
      connectionId: null,
      addedAt: 1
    }
    const runtime = new OrcaRuntimeService({
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)

    const snapshot = await runtime.listMobileSessionTabs(`id:${workspaceKey}`)

    expect(snapshot.worktree).toBe(worktreeId)
  })

  it('evicts a cached scoped snapshot when persisted Git owner aliases collide', () => {
    const worktreeId = `${REPO_ID}::/worktrees/cached-alias-collision`
    const workspaceKey = worktreeWorkspaceKey(worktreeId)
    const session = makeSession({
      worktreeId,
      ptyId: 'cached-alias-raw-pty',
      tabId: 'cached-alias-raw-tab'
    })
    session.tabsByWorktree[workspaceKey] = [
      {
        ...session.tabsByWorktree[worktreeId]![0]!,
        id: 'cached-alias-scoped-tab',
        ptyId: 'cached-alias-scoped-pty',
        worktreeId: workspaceKey
      }
    ]
    const repo: Repo = {
      id: REPO_ID,
      path: '/workspace/repo',
      displayName: 'Alias collision repo',
      badgeColor: 'blue',
      connectionId: null,
      addedAt: 1
    }
    const runtime = new OrcaRuntimeService({
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const cached: RuntimeMobileSessionTabsSnapshot = {
      worktree: workspaceKey,
      publicationEpoch: 'headless-hydrated:cached-scoped-alias',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: 'cached-scoped-surface',
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: 'cached-scoped-surface',
          parentTabId: 'cached-alias-scoped-tab',
          leafId: INCARNATION_ID,
          ptyId: `ssh:${CONNECTION_ID}@@cached-alias-scoped-pty`,
          title: 'Cached scoped terminal',
          isActive: true
        }
      ]
    }
    internals.mobileSessionTabsByWorktree.set(workspaceKey, cached)
    runtime.attachWindow(93)

    runtime.syncWindowGraph(93, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [cached]
    })

    expect(internals.mobileSessionTabsByWorktree.has(workspaceKey)).toBe(false)
    expect(internals.mobileSessionTabsByWorktree.has(worktreeId)).toBe(false)
  })

  it('does not publish a cached relay snapshot from a stale singleton partition', async () => {
    const runtimeHostId = toRuntimeExecutionHostId('moved-folder-owner')
    const folder = makeFolder(runtimeHostId)
    const folderKey = `folder:${folder.id}`
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [
        'local',
        makeSession({
          worktreeId: folderKey,
          ptyId: `ssh:${CONNECTION_ID}@@stale-local-folder-pty`,
          tabId: 'stale-local-folder-tab'
        })
      ]
    ])
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getFolderWorkspaces: () => [folder],
      getProjectGroups: () => [makeGroup(runtimeHostId)],
      getWorkspaceSession: (hostId?: string | null) =>
        sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorktreeMeta: () => undefined
    } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    vi.spyOn(
      runtime as unknown as { listResolvedWorktrees: () => Promise<[]> },
      'listResolvedWorktrees'
    ).mockResolvedValue([])
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      sshRelayRecoveryGenerationByTargetId: Map<string, number>
      publishRecoveredSshMobileSessionTabs: (
        targetId: string,
        generation: number,
        generationIsCurrent: () => boolean
      ) => Promise<void>
    }
    internals.mobileSessionTabsByWorktree.set(folderKey, {
      worktree: folderKey,
      publicationEpoch: 'headless-hydrated:stale-local-owner',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    internals.sshRelayRecoveryGenerationByTargetId.set(CONNECTION_ID, 1)
    const events: unknown[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await internals.publishRecoveredSshMobileSessionTabs(CONNECTION_ID, 1, () => true)

    expect(events).toEqual([])
  })

  it('indexes folder ownership from unified terminal state in its declared host', () => {
    const runtimeHostId = toRuntimeExecutionHostId('unified-folder-owner')
    const folder = makeFolder(runtimeHostId)
    const folderKey = `folder:${folder.id}`
    const remoteSession = getDefaultWorkspaceSession()
    remoteSession.unifiedTabs = {
      [folderKey]: [
        {
          id: 'unified-folder-tab',
          entityId: 'unified-folder-tab',
          groupId: 'unified-folder-group',
          worktreeId: folderKey,
          contentType: 'terminal',
          label: 'Unified folder terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      ['local', getDefaultWorkspaceSession()],
      [runtimeHostId, remoteSession]
    ])
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getFolderWorkspaces: () => [folder],
      getProjectGroups: () => [makeGroup(runtimeHostId)],
      getWorkspaceSession: (hostId?: string | null) =>
        sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()]
    } as never)
    const known = (
      runtime as unknown as {
        getKnownWorkspaceSessionWorktrees: () => {
          sessionByWorktreeId: Map<string, WorkspaceSessionState>
        }
      }
    ).getKnownWorkspaceSessionWorktrees()

    expect(known.sessionByWorktreeId.get(folderKey)).toBe(remoteSession)
  })

  it('indexes folder ownership from persisted browser-page state', () => {
    const runtimeHostId = toRuntimeExecutionHostId('browser-page-folder-owner')
    const folder = makeFolder(runtimeHostId)
    const folderKey = folderWorkspaceKey(folder.id)
    const remoteSession = getDefaultWorkspaceSession()
    remoteSession.browserPagesByWorkspace = {
      'browser-workspace': [
        {
          id: 'browser-page',
          workspaceId: 'browser-workspace',
          worktreeId: folderKey,
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      ['local', getDefaultWorkspaceSession()],
      [runtimeHostId, remoteSession]
    ])
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getFolderWorkspaces: () => [folder],
      getProjectGroups: () => [makeGroup(runtimeHostId)],
      getWorkspaceSession: (hostId?: string | null) =>
        sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()]
    } as never)
    const known = (
      runtime as unknown as {
        getKnownWorkspaceSessionWorktrees: () => {
          sessionByWorktreeId: Map<string, WorkspaceSessionState>
        }
      }
    ).getKnownWorkspaceSessionWorktrees()

    expect(known.sessionByWorktreeId.get(folderKey)).toBe(remoteSession)
  })

  it('indexes active-only folder ownership in its declared host', () => {
    const runtimeHostId = toRuntimeExecutionHostId('active-folder-owner')
    const folder = makeFolder(runtimeHostId)
    const folderKey = folderWorkspaceKey(folder.id)
    const remoteSession = getDefaultWorkspaceSession()
    remoteSession.activeWorkspaceKey = folderKey
    remoteSession.activeWorktreeId = folderKey
    remoteSession.activeTabId = 'active-folder-tab'
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      ['local', getDefaultWorkspaceSession()],
      [runtimeHostId, remoteSession]
    ])
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getFolderWorkspaces: () => [folder],
      getProjectGroups: () => [makeGroup(runtimeHostId)],
      getWorkspaceSession: (hostId?: string | null) =>
        sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()]
    } as never)
    const known = (
      runtime as unknown as {
        getKnownWorkspaceSessionWorktrees: () => {
          sessionByWorktreeId: Map<string, WorkspaceSessionState>
        }
      }
    ).getKnownWorkspaceSessionWorktrees()

    expect(known.sessionByWorktreeId.get(folderKey)).toBe(remoteSession)
  })

  it.each(['unified', 'active', 'sleeping', 'surface'] as const)(
    'uses %s-only persisted ownership for direct duplicate-repo host resolution',
    (ownerSource) => {
      const worktreeId = `${REPO_ID}::/worktrees/remote-feature`
      const runtimeHostId = toRuntimeExecutionHostId(`${ownerSource}-git-owner`)
      const remoteSession = getDefaultWorkspaceSession()
      if (ownerSource === 'unified') {
        remoteSession.unifiedTabs = {
          [worktreeId]: [
            {
              id: `${ownerSource}-tab`,
              entityId: `${ownerSource}-tab`,
              groupId: `${ownerSource}-group`,
              worktreeId,
              contentType: 'terminal',
              label: 'Remote terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      } else if (ownerSource === 'active') {
        remoteSession.activeWorkspaceKey = worktreeWorkspaceKey(worktreeId)
        remoteSession.activeWorktreeId = worktreeId
        remoteSession.activeTabId = `${ownerSource}-tab`
      } else if (ownerSource === 'sleeping') {
        const paneKey = makePaneKey(`${ownerSource}-tab`, INCARNATION_ID)
        remoteSession.sleepingAgentSessionsByPaneKey = {
          [paneKey]: {
            paneKey,
            tabId: `${ownerSource}-tab`,
            worktreeId,
            agent: 'codex',
            providerSession: { key: 'session_id', id: `${ownerSource}-session` },
            prompt: 'Continue',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } else {
        remoteSession.terminalSurfaceTombstonesByPaneKey = {
          [makePaneKey(`${ownerSource}-tab`, INCARNATION_ID)]: {
            worktreeId,
            parentTabId: `${ownerSource}-tab`,
            leafId: INCARNATION_ID,
            ptyId: `${ownerSource}-pty`,
            incarnationId: INCARNATION_ID,
            retiredAt: 1
          }
        }
      }
      const localRepo: Repo = {
        id: REPO_ID,
        path: '/workspace/local-root',
        displayName: 'Local duplicate',
        badgeColor: 'blue',
        connectionId: null,
        executionHostId: null,
        addedAt: 1
      }
      const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
        ['local', getDefaultWorkspaceSession()],
        [runtimeHostId, remoteSession]
      ])
      const runtime = new OrcaRuntimeService({
        getRepo: () => localRepo,
        getRepos: () => [
          localRepo,
          {
            ...localRepo,
            path: '/runtime/remote-root',
            displayName: 'Runtime duplicate',
            executionHostId: runtimeHostId
          }
        ],
        getWorkspaceSession: (hostId?: string | null) =>
          sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
        getWorkspaceSessionHostIds: () => [...sessions.keys()],
        getWorktreeMeta: () => undefined
      } as never)
      const internals = runtime as unknown as {
        getKnownWorkspaceSessionWorktrees: () => {
          sessionByWorktreeId: Map<string, WorkspaceSessionState>
        }
        getWorkspaceSessionHostIdForWorktree: (worktreeId: string) => ExecutionHostId
      }

      expect(
        internals.getKnownWorkspaceSessionWorktrees().sessionByWorktreeId.get(worktreeId)
      ).toBe(remoteSession)
      expect(internals.getWorkspaceSessionHostIdForWorktree(worktreeId)).toBe(runtimeHostId)
    }
  )

  it('hydrates a raw Git snapshot from its canonical workspace-key owner', () => {
    const worktreeId = `${REPO_ID}::/worktrees/canonical-feature`
    const workspaceKey = worktreeWorkspaceKey(worktreeId)
    const session = makeSession({
      worktreeId: workspaceKey,
      ptyId: `ssh:${CONNECTION_ID}@@canonical-feature-pty`,
      tabId: 'canonical-feature-tab'
    })
    session.activeTabIdByWorktree = { [workspaceKey]: 'canonical-feature-tab' }
    const repo: Repo = {
      id: REPO_ID,
      path: '/workspace/repo',
      displayName: 'Canonical owner repo',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const runtime = new OrcaRuntimeService({
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)
    const internals = runtime as unknown as {
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (
        owner: string,
        options: { allowAttachedWindow: true; workspaceSession: WorkspaceSessionState }
      ) => Set<string>
      mobileSessionTabsByWorktree: Map<
        string,
        { worktree: string; tabs: { parentTabId?: string; isActive?: boolean }[] }
      >
    }

    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      workspaceSession: session
    })

    expect(internals.mobileSessionTabsByWorktree.has(workspaceKey)).toBe(false)
    expect(internals.mobileSessionTabsByWorktree.get(worktreeId)).toMatchObject({
      worktree: worktreeId,
      tabs: [{ parentTabId: 'canonical-feature-tab', isActive: true }]
    })
  })

  it('persists headless activation through the existing scoped owner key', () => {
    const worktreeId = `${REPO_ID}::/worktrees/scoped-activation`
    const workspaceKey = worktreeWorkspaceKey(worktreeId)
    const tabId = 'scoped-activation-tab'
    const session = makeSession({ worktreeId: workspaceKey, ptyId: 'scoped-activation-pty', tabId })
    session.activeTabIdByWorktree = { [workspaceKey]: 'previous-tab' }
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService({
      getRepo: () => ({
        id: REPO_ID,
        path: '/workspace/repo',
        displayName: 'Scoped activation repo',
        badgeColor: 'blue',
        connectionId: null,
        addedAt: 1
      }),
      getRepos: () => [],
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local'],
      setWorkspaceSession
    } as never)
    const tab = {
      type: 'terminal' as const,
      id: `${tabId}::${INCARNATION_ID}`,
      parentTabId: tabId,
      leafId: INCARNATION_ID,
      title: 'Scoped activation',
      isActive: true
    }

    const internals = runtime as unknown as {
      persistHeadlessTerminalActiveLeaf: (owner: string, terminal: typeof tab) => void
    }
    internals.persistHeadlessTerminalActiveLeaf(worktreeId, tab)

    expect(setWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({ activeTabIdByWorktree: { [workspaceKey]: tabId } }),
      'local'
    )
  })

  it('treats workspace-key and worktree-id owners as the same ambiguous Git workspace', () => {
    const worktreeId = `${REPO_ID}::/worktrees/aliased-feature`
    const runtimeHostId = toRuntimeExecutionHostId('aliased-git-owner')
    const localSession = getDefaultWorkspaceSession()
    localSession.tabsByWorktree = {
      [worktreeId]: [
        {
          id: 'local-alias-tab',
          ptyId: 'local-alias-pty',
          worktreeId,
          title: 'Local terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    const remoteSession = getDefaultWorkspaceSession()
    remoteSession.activeWorkspaceKey = worktreeWorkspaceKey(worktreeId)
    remoteSession.activeTabId = 'remote-alias-tab'
    const localRepo: Repo = {
      id: REPO_ID,
      path: '/workspace/local-root',
      displayName: 'Local duplicate',
      badgeColor: 'blue',
      connectionId: null,
      executionHostId: null,
      addedAt: 1
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      ['local', localSession],
      [runtimeHostId, remoteSession]
    ])
    const runtime = new OrcaRuntimeService({
      getRepo: () => localRepo,
      getRepos: () => [
        localRepo,
        {
          ...localRepo,
          path: '/runtime/remote-root',
          displayName: 'Runtime duplicate',
          executionHostId: runtimeHostId
        }
      ],
      getWorkspaceSession: (hostId?: string | null) =>
        sessions.get((hostId ?? 'local') as ExecutionHostId) ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorktreeMeta: () => undefined
    } as never)
    const known = (
      runtime as unknown as {
        getKnownWorkspaceSessionWorktrees: () => {
          worktreeIds: Set<string>
          sessionByWorktreeId: Map<string, WorkspaceSessionState>
          ambiguousHostWorktreeIds: Set<string>
        }
      }
    ).getKnownWorkspaceSessionWorktrees()

    expect(known.worktreeIds).toEqual(new Set([worktreeId]))
    expect(known.sessionByWorktreeId.has(worktreeId)).toBe(false)
    expect(known.ambiguousHostWorktreeIds).toEqual(new Set([worktreeId]))
  })
})
