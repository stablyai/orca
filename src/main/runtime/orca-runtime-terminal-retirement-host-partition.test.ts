import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const CONNECTION_ID = 'conn-1'
const SSH_HOST_ID: ExecutionHostId = `ssh:${CONNECTION_ID}`
const SSH_REPO_ID = 'ssh-repo'
const SSH_WORKTREE_ID = `${SSH_REPO_ID}::/remote/worktree`
const SSH_PTY_LEFT = `ssh:${CONNECTION_ID}@@pty-left`
const SSH_PTY_RIGHT = `ssh:${CONNECTION_ID}@@pty-right`

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
