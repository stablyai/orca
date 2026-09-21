import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'

const CONNECTION_ID = 'conn-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${CONNECTION_ID}`
const SSH_REPO_ID = 'ssh-repo'
const SSH_WORKTREE_ID = `${SSH_REPO_ID}::/remote/worktree`
const SSH_PTY_LEFT = `ssh:${CONNECTION_ID}@@pty-left`
const SSH_PTY_RIGHT = `ssh:${CONNECTION_ID}@@pty-right`

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const SSH_REPO = {
  id: SSH_REPO_ID,
  path: '/remote/worktree',
  displayName: 'ssh-repo',
  badgeColor: 'blue',
  addedAt: 1,
  connectionId: CONNECTION_ID
} as const

function makeSshSnapshot(): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: 'left' },
      second: { type: 'leaf' as const, leafId: 'right' }
    },
    activeLeafId: 'left',
    expandedLeafId: 'left',
    ptyIdsByLeafId: { left: SSH_PTY_LEFT, right: SSH_PTY_RIGHT }
  }
  return {
    worktree: SSH_WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: 'tab::left',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
    tabs: [
      {
        type: 'terminal',
        id: 'tab::left',
        parentTabId: 'tab',
        leafId: 'left',
        ptyId: SSH_PTY_LEFT,
        title: 'Left',
        parentLayout,
        isActive: true
      },
      {
        type: 'terminal',
        id: 'tab::right',
        parentTabId: 'tab',
        leafId: 'right',
        ptyId: SSH_PTY_RIGHT,
        title: 'Right',
        parentLayout,
        isActive: false
      }
    ]
  }
}

function makePersistedSshSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [SSH_WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: SSH_PTY_LEFT,
          worktreeId: SSH_WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split' as const,
          direction: 'vertical' as const,
          first: { type: 'leaf' as const, leafId: 'left' },
          second: { type: 'leaf' as const, leafId: 'right' }
        },
        activeLeafId: 'left',
        expandedLeafId: null,
        ptyIdsByLeafId: { left: SSH_PTY_LEFT, right: SSH_PTY_RIGHT }
      }
    }
  }
}

type PartitionedStoreHarness = {
  store: never
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
  writes: { hostId: ExecutionHostId | undefined; session: WorkspaceSessionState }[]
  reads: (ExecutionHostId | undefined)[]
}

/** A store that keeps one workspace session per execution host, like the real one. */
function partitionedStore(): PartitionedStoreHarness {
  const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
    [LOCAL_EXECUTION_HOST_ID, getDefaultWorkspaceSession()],
    [SSH_HOST_ID, makePersistedSshSession()]
  ])
  const writes: { hostId: ExecutionHostId | undefined; session: WorkspaceSessionState }[] = []
  const reads: (ExecutionHostId | undefined)[] = []
  const store = {
    getRepos: () => [SSH_REPO],
    getRepo: (id: string) => (id === SSH_REPO_ID ? SSH_REPO : undefined),
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId?: ExecutionHostId) => {
      reads.push(hostId)
      return sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession()
    },
    setWorkspaceSession: (session: WorkspaceSessionState, hostId?: ExecutionHostId) => {
      writes.push({ hostId, session })
      sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, session)
    },
    flushOrThrow: vi.fn()
  } as never
  return { store, sessions, writes, reads }
}

function syncSshSplit(runtime: OrcaRuntimeService, snapshot: RuntimeMobileSessionTabsSnapshot) {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: SSH_WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: 'left',
        layout:
          snapshot.tabs[0]?.type === 'terminal'
            ? (snapshot.tabs[0].parentLayout?.root ?? null)
            : null
      }
    ],
    leaves: [
      {
        tabId: 'tab',
        worktreeId: SSH_WORKTREE_ID,
        leafId: 'left',
        paneRuntimeId: 1,
        ptyId: SSH_PTY_LEFT
      },
      {
        tabId: 'tab',
        worktreeId: SSH_WORKTREE_ID,
        leafId: 'right',
        paneRuntimeId: 2,
        ptyId: SSH_PTY_RIGHT
      }
    ],
    mobileSessionTabs: [snapshot]
  })
}

describe('OrcaRuntimeService terminal retirement host partitioning (STA-3463)', () => {
  it('routes a stale catalog owner to the unique persisted session owner', async () => {
    const staleHostId: ExecutionHostId = 'runtime:stale-host'
    const persistedTab = {
      id: 'tab',
      ptyId: 'persisted-pty',
      worktreeId: SSH_WORKTREE_ID,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const localSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [SSH_WORKTREE_ID]: [persistedTab] },
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf', leafId: 'leaf' },
          activeLeafId: 'leaf',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf: 'persisted-pty' }
        }
      }
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, localSession],
      [
        staleHostId,
        {
          ...getDefaultWorkspaceSession(),
          // A prior close can leave an empty retained row in the stale partition.
          tabsByWorktree: { [SSH_WORKTREE_ID]: [] }
        }
      ]
    ])
    const store = {
      getRepos: () => [{ ...SSH_REPO, executionHostId: staleHostId }],
      getRepo: () => ({ ...SSH_REPO, executionHostId: staleHostId }),
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorkspaceSession: (hostId?: ExecutionHostId) =>
        sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession(),
      setWorkspaceSession: (session: WorkspaceSessionState, hostId?: ExecutionHostId) =>
        sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, session),
      flushOrThrow: vi.fn()
    } as never
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null
    })
    runtime.registerPty('persisted-pty', SSH_WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'leaf'
    })

    await expect(
      runtime.closeMobileSessionTab(`id:${SSH_WORKTREE_ID}`, 'tab')
    ).resolves.toMatchObject({
      closed: true
    })
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)?.tabsByWorktree[SSH_WORKTREE_ID]).toEqual([])
    expect(sessions.get(staleHostId)?.tabsByWorktree[SSH_WORKTREE_ID]).toEqual([])
  })

  it('keeps a same-id local workspace out of an SSH workspace close', async () => {
    const localTab = {
      id: 'local-tab',
      ptyId: 'local-pty',
      worktreeId: SSH_WORKTREE_ID,
      title: 'Local agent',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [
        LOCAL_EXECUTION_HOST_ID,
        {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { [SSH_WORKTREE_ID]: [localTab] },
          terminalLayoutsByTabId: {
            'local-tab': {
              root: { type: 'leaf', leafId: 'leaf' },
              activeLeafId: 'leaf',
              expandedLeafId: null,
              ptyIdsByLeafId: { leaf: 'local-pty' }
            }
          },
          sleepingAgentSessionsByPaneKey: {
            'local-tab:leaf': {
              paneKey: 'local-tab:leaf',
              tabId: 'local-tab',
              worktreeId: SSH_WORKTREE_ID,
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'resume-target' },
              prompt: '',
              state: 'working',
              capturedAt: 1,
              updatedAt: 1
            }
          }
        }
      ],
      // The SSH copy of the same `repoId::path` currently has no terminals.
      [SSH_HOST_ID, { ...getDefaultWorkspaceSession(), tabsByWorktree: { [SSH_WORKTREE_ID]: [] } }]
    ])
    const store = {
      getRepos: () => [SSH_REPO],
      getRepo: (id: string) => (id === SSH_REPO_ID ? SSH_REPO : undefined),
      getWorktreeMeta: () => ({ hostId: SSH_HOST_ID }),
      getAllWorktreeMeta: () => ({ [SSH_WORKTREE_ID]: { hostId: SSH_HOST_ID } }),
      setWorktreeMeta: vi.fn(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorkspaceSession: (hostId?: ExecutionHostId) =>
        sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession(),
      setWorkspaceSession: (session: WorkspaceSessionState, hostId?: ExecutionHostId) =>
        sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, session),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn()
    } as never
    const runtime = new OrcaRuntimeService(store)
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('local-pty', SSH_WORKTREE_ID, null, { tabId: 'local-tab', leafId: 'leaf' })

    await expect(runtime.closeTerminalsForWorktree(`id:${SSH_WORKTREE_ID}`)).resolves.toEqual({
      closed: 0,
      stopped: 0,
      retiredSurfaces: true
    })
    expect(stopAndWait).not.toHaveBeenCalled()
    const local = sessions.get(LOCAL_EXECUTION_HOST_ID)!
    expect(local.tabsByWorktree[SSH_WORKTREE_ID]).toEqual([localTab])
    expect(Object.keys(local.sleepingAgentSessionsByPaneKey ?? {})).toEqual(['local-tab:leaf'])
  })

  it('clears resume records from the partition that owned the tabs when the catalog owner rotated', async () => {
    const staleHostId: ExecutionHostId = 'runtime:stale-host'
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [
        LOCAL_EXECUTION_HOST_ID,
        {
          ...makePersistedSshSession(),
          terminalPtyIncarnationsByPaneKey: { 'tab:left': 'incarnation-1' }
        }
      ],
      [staleHostId, { ...getDefaultWorkspaceSession(), tabsByWorktree: { [SSH_WORKTREE_ID]: [] } }]
    ])
    const store = {
      getRepos: () => [{ ...SSH_REPO, executionHostId: staleHostId }],
      getRepo: () => ({ ...SSH_REPO, executionHostId: staleHostId }),
      getWorktreeMeta: () => ({}),
      getAllWorktreeMeta: () => ({ [SSH_WORKTREE_ID]: {} }),
      setWorktreeMeta: vi.fn(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      getWorkspaceSession: (hostId?: ExecutionHostId) =>
        sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession(),
      setWorkspaceSession: (session: WorkspaceSessionState, hostId?: ExecutionHostId) =>
        sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, session),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn()
    } as never
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(SSH_PTY_LEFT, SSH_WORKTREE_ID, null, { tabId: 'tab', leafId: 'left' })

    await expect(runtime.closeTerminalsForWorktree(`id:${SSH_WORKTREE_ID}`)).resolves.toMatchObject(
      { closed: 1 }
    )
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)?.tabsByWorktree[SSH_WORKTREE_ID]).toEqual([])
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)?.terminalPtyIncarnationsByPaneKey).toEqual({})
  })

  it('hydrates the persisted owner when a folder host is absent from the host index', () => {
    const folderWorktreeId = 'folder:folder-1'
    const localSession = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [folderWorktreeId]: [
          {
            id: 'folder-tab',
            ptyId: null,
            worktreeId: folderWorktreeId,
            title: 'Folder'
          }
        ]
      }
    }
    const folderHostId: ExecutionHostId = 'runtime:folder-host'
    const store = {
      getRepos: () => [],
      getFolderWorkspaces: () => [
        {
          id: 'folder-1',
          projectGroupId: 'project-1',
          name: 'Folder',
          folderPath: '/tmp/folder',
          executionHostId: folderHostId
        }
      ],
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      getWorkspaceSession: (hostId?: ExecutionHostId) =>
        hostId === LOCAL_EXECUTION_HOST_ID ? localSession : getDefaultWorkspaceSession()
    } as never
    const controller = new RuntimeWorkspaceSessionController({
      getStore: () => store,
      resolveFolderConnectionId: () => null,
      hasRuntimeOwnedPtyCandidate: () => false
    })

    const targets = controller.getHydrationTargets(true)

    expect(targets.get(folderWorktreeId)).toBe(localSession)
  })

  it('waits for provider retirement on a direct worktree stop', async () => {
    const harness = partitionedStore()
    const runtime = new OrcaRuntimeService(harness.store)
    const physicalStop = makeDeferred()
    const kill = vi.fn(() => true)
    const stopAndWait = vi.fn(async () => {
      await physicalStop.promise
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSshSplit(runtime, makeSshSnapshot())
    runtime.registerPty(SSH_PTY_LEFT, SSH_WORKTREE_ID, CONNECTION_ID, {
      tabId: 'tab',
      leafId: 'left'
    })

    const stopping = runtime.stopTerminalsForWorktree(`id:${SSH_WORKTREE_ID}`, {
      resolvedWorktreeId: SSH_WORKTREE_ID
    })
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledWith(SSH_PTY_LEFT))
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(kill).not.toHaveBeenCalled()

    physicalStop.resolve()
    await expect(stopping).resolves.toEqual({ stopped: 2 })
  })

  it('continues stopping later PTYs when one provider retirement rejects', async () => {
    const harness = partitionedStore()
    const runtime = new OrcaRuntimeService(harness.store)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      if (ptyId === SSH_PTY_LEFT) {
        throw new Error('relay_unavailable')
      }
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSshSplit(runtime, makeSshSnapshot())
    runtime.registerPty(SSH_PTY_LEFT, SSH_WORKTREE_ID, CONNECTION_ID, {
      tabId: 'tab',
      leafId: 'left'
    })
    runtime.registerPty(SSH_PTY_RIGHT, SSH_WORKTREE_ID, CONNECTION_ID, {
      tabId: 'tab',
      leafId: 'right'
    })

    await expect(
      runtime.stopTerminalsForWorktree(`id:${SSH_WORKTREE_ID}`, {
        resolvedWorktreeId: SSH_WORKTREE_ID
      })
    ).resolves.toEqual({ stopped: 1 })
    expect(stopAndWait).toHaveBeenNthCalledWith(1, SSH_PTY_LEFT)
    expect(stopAndWait).toHaveBeenNthCalledWith(2, SSH_PTY_RIGHT)
  })

  it('retires an exited SSH pane from the SSH partition and leaves the local partition untouched', async () => {
    const harness = partitionedStore()
    const localBefore = harness.sessions.get(LOCAL_EXECUTION_HOST_ID)!
    const runtime = new OrcaRuntimeService(harness.store)
    runtime.attachWindow(1)
    syncSshSplit(runtime, makeSshSnapshot())
    runtime.registerPty(SSH_PTY_LEFT, SSH_WORKTREE_ID, CONNECTION_ID, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-a'
    })

    runtime.onPtyExit(SSH_PTY_LEFT, 0, 'incarnation-a')

    // The durable retirement must land in the pane's own host partition.
    expect(harness.writes.map((write) => write.hostId)).toEqual([SSH_HOST_ID])
    const sshSession = harness.sessions.get(SSH_HOST_ID)!
    expect(sshSession.terminalLayoutsByTabId.tab).toMatchObject({
      root: { type: 'leaf', leafId: 'right' },
      ptyIdsByLeafId: { right: SSH_PTY_RIGHT }
    })
    expect(sshSession.tabsByWorktree[SSH_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'tab', ptyId: SSH_PTY_RIGHT })
    ])
    expect(sshSession.terminalTopologyRevisionByRepoId).toMatchObject({ [SSH_REPO_ID]: 1 })

    // Negative safety: the local partition is a different host and must not move.
    expect(harness.sessions.get(LOCAL_EXECUTION_HOST_ID)).toBe(localBefore)
    expect(harness.sessions.get(LOCAL_EXECUTION_HOST_ID)?.terminalTopologyRevisionByRepoId).toEqual(
      localBefore.terminalTopologyRevisionByRepoId
    )

    // And the published surface is actually gone for clients.
    expect((await runtime.listMobileSessionTabs(`id:${SSH_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'tab::right' })
    ])
  })

  it('still retires a local pane from the local partition', async () => {
    const harness = partitionedStore()
    const sshBefore = harness.sessions.get(SSH_HOST_ID)!
    const localRepo = {
      id: 'local-repo',
      path: '/worktree',
      displayName: 'local-repo',
      badgeColor: 'blue',
      addedAt: 1
    } as const
    const localWorktreeId = 'local-repo::/worktree'
    const localSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [localWorktreeId]: [
          {
            id: 'tab',
            ptyId: 'pty-left',
            worktreeId: localWorktreeId,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab: {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, leafId: 'left' },
            second: { type: 'leaf' as const, leafId: 'right' }
          },
          activeLeafId: 'left',
          expandedLeafId: null,
          ptyIdsByLeafId: { left: 'pty-left', right: 'pty-right' }
        }
      }
    }
    harness.sessions.set(LOCAL_EXECUTION_HOST_ID, localSession)
    const store = {
      ...(harness.store as object),
      getRepos: () => [SSH_REPO, localRepo],
      getRepo: (id: string) =>
        id === SSH_REPO_ID ? SSH_REPO : id === 'local-repo' ? localRepo : undefined
    } as never
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    const snapshot = makeSshSnapshot()
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: localWorktreeId,
          title: 'Terminal',
          activeLeafId: 'left',
          layout:
            snapshot.tabs[0]?.type === 'terminal'
              ? (snapshot.tabs[0].parentLayout?.root ?? null)
              : null
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: localWorktreeId,
          leafId: 'left',
          paneRuntimeId: 1,
          ptyId: 'pty-left'
        },
        {
          tabId: 'tab',
          worktreeId: localWorktreeId,
          leafId: 'right',
          paneRuntimeId: 2,
          ptyId: 'pty-right'
        }
      ],
      mobileSessionTabs: [
        {
          ...snapshot,
          worktree: localWorktreeId,
          tabs: snapshot.tabs.map((tab) =>
            tab.type === 'terminal'
              ? {
                  ...tab,
                  ptyId: tab.leafId === 'left' ? 'pty-left' : 'pty-right',
                  parentLayout: tab.parentLayout
                    ? {
                        ...tab.parentLayout,
                        ptyIdsByLeafId: { left: 'pty-left', right: 'pty-right' }
                      }
                    : undefined
                }
              : tab
          )
        }
      ]
    })
    runtime.registerPty('pty-left', localWorktreeId, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-a'
    })

    runtime.onPtyExit('pty-left', 0, 'incarnation-a')

    expect(harness.writes.map((write) => write.hostId ?? LOCAL_EXECUTION_HOST_ID)).toEqual([
      LOCAL_EXECUTION_HOST_ID
    ])
    expect(harness.sessions.get(LOCAL_EXECUTION_HOST_ID)?.terminalLayoutsByTabId.tab).toMatchObject(
      {
        root: { type: 'leaf', leafId: 'right' }
      }
    )
    expect(harness.sessions.get(SSH_HOST_ID)).toBe(sshBefore)
    expect((await runtime.listMobileSessionTabs(`id:${localWorktreeId}`)).tabs).toEqual([
      expect.objectContaining({ id: 'tab::right' })
    ])
  })
})
