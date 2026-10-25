/** Project removal must close structured sessions and retire chat tabs itself; PTY sweeps cannot see them. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { RepoHostTarget } from '../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../shared/execution-host'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const { TEST_REPO_ID, TEST_WORKTREE_ID, store } = await import('./orca-runtime-test-fixtures.spec')

type FakeRecord = {
  sessionId: string
  provider: 'claude' | 'codex'
  location: { executionHostId: string; workspaceId: string }
  lease: { claimStatus: string; deathEvidence: unknown }
}

function record(sessionId: string, workspaceId: string, executionHostId = 'local'): FakeRecord {
  return {
    sessionId,
    provider: 'claude',
    location: { executionHostId, workspaceId },
    lease: { claimStatus: 'live', deathEvidence: null }
  }
}

function installHost(records: FakeRecord[], detached: string[] = []) {
  const held = new Set(
    records.map((entry) => entry.sessionId).filter((id) => !detached.includes(id))
  )
  const visible = new Set(records.map((entry) => entry.sessionId))
  const closed: string[] = []
  hostRef.current = {
    deps: {
      store: {
        listRecords: () => records,
        getRecord: (sessionId: string) => records.find((entry) => entry.sessionId === sessionId),
        getSessionTabId: (sessionId: string) => (visible.has(sessionId) ? `tab-${sessionId}` : null)
      },
      logger: { warn: () => {} }
    },
    hasSession: (sessionId: string) => held.has(sessionId),
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] }),
    setSessionTabVisibility: async (sessionId: string, isVisible: boolean) => {
      if (isVisible) {
        visible.add(sessionId)
      } else {
        visible.delete(sessionId)
      }
    },
    close: async (sessionId: string) => {
      closed.push(sessionId)
      held.delete(sessionId)
      const entry = records.find((candidate) => candidate.sessionId === sessionId)
      if (entry) {
        entry.lease.claimStatus = 'released'
        entry.lease.deathEvidence = { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
      }
    }
  }
  return { closed, visible }
}

function createRuntime(rows: Repo[]) {
  let current = rows
  const runtime = new OrcaRuntimeService({
    ...store,
    getRepo: (id: string) => current.find((row) => row.id === id),
    getRepos: () => current,
    removeProjectForHost: (target: RepoHostTarget) => {
      const hostId = getRepoExecutionHostId(target)
      current = current.filter(
        (row) => row.id !== target.id || getRepoExecutionHostId(row) !== hostId
      )
    }
  })
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => false),
    stopAndWait: vi.fn(async () => true),
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return runtime
}

describe('project removal and native chat sessions', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it("closes the project's live chats and retires every chat tab, on this host only", async () => {
    const hiddenWorkspace = `${TEST_REPO_ID}::/tmp/hidden-worktree`
    const { closed, visible } = installHost(
      [
        record('live-chat', TEST_WORKTREE_ID),
        record('resting-chat', hiddenWorkspace),
        record('ssh-twin-chat', TEST_WORKTREE_ID, 'ssh:ssh-target'),
        record('other-project-chat', 'repo-2::/tmp/other')
      ],
      ['resting-chat']
    )
    const runtime = createRuntime([store.getRepo(TEST_REPO_ID)!])

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    expect(closed).toEqual(['live-chat'])
    expect([...visible].sort()).toEqual(['other-project-chat', 'ssh-twin-chat'])
  })

  it('leaves the local twin chats alone when removing the SSH copy of the id', async () => {
    const localRow = store.getRepo(TEST_REPO_ID)!
    const sshRow: Repo = { ...localRow, path: '/srv/ssh-copy', connectionId: 'ssh-target' }
    const { closed, visible } = installHost([
      record('local-chat', TEST_WORKTREE_ID),
      record('ssh-chat', TEST_WORKTREE_ID, 'ssh:ssh-target')
    ])
    const runtime = createRuntime([localRow, sshRow])

    await runtime.removeProject('path:/srv/ssh-copy')

    expect(closed).toEqual(['ssh-chat'])
    expect([...visible]).toEqual(['local-chat'])
  })

  it('still closes the chats when the terminal stop fails', async () => {
    const { closed } = installHost([record('live-chat', TEST_WORKTREE_ID)])
    const runtime = createRuntime([store.getRepo(TEST_REPO_ID)!])
    runtime.registerPty('pty-1', TEST_WORKTREE_ID, null)
    vi.spyOn(runtime, 'stopTerminalsForWorktree').mockRejectedValue(
      new Error('runtime_unavailable')
    )

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    expect(closed).toEqual(['live-chat'])
  })

  it('still closes the chats when the terminal stops spent the removal budget', async () => {
    const { closed } = installHost([record('live-chat', TEST_WORKTREE_ID)])
    const runtime = createRuntime([])

    await runtime.stopTerminalsForProject(store.getRepo(TEST_REPO_ID)!, {
      deadline: Date.now() - 1,
      closeStructuredSessions: true
    })

    expect(closed).toEqual(['live-chat'])
  })

  it("closes a local project's chats though a paired server's residue row shares its id", async () => {
    const localRow = store.getRepo(TEST_REPO_ID)!
    const residue: Repo = { ...localRow, executionHostId: 'runtime:env-1' }
    const { closed } = installHost([record('local-chat', TEST_WORKTREE_ID)])
    const runtime = createRuntime([localRow, residue])

    await runtime.removeProject(localRow)

    expect(closed).toEqual(['local-chat'])
  })

  it('still asks every terminal to stop once the removal budget is spent', async () => {
    installHost([])
    const runtime = createRuntime([store.getRepo(TEST_REPO_ID)!])
    runtime.registerPty('pty-1', TEST_WORKTREE_ID, null)
    runtime.registerPty('pty-2', TEST_WORKTREE_ID, null)
    const kill = vi.fn((_ptyId: string) => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      stopAndWait: vi.fn(async () => true),
      getForegroundProcess: async () => null
    })

    await runtime.stopTerminalsForProject(store.getRepo(TEST_REPO_ID)!, {
      deadline: Date.now() - 1
    })

    expect(kill.mock.calls.map(([ptyId]) => ptyId).sort()).toEqual(['pty-1', 'pty-2'])
  })
})
