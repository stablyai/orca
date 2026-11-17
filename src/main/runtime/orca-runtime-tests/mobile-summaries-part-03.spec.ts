import { describe, expect, it } from 'vitest'
import './bind-first-pane.test-fixture'
import '../terminal/identity/agent-status-store-wiring.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/orca-profiles/constants'
import '../orca-runtime-test-mocks/setup.spec'
import 'node:path'
import '../../workspaces/catalog/worktree-path-comparison-key'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'

// No SSH Git provider is installed, so these fixtures use stored rows.
function storedWorktreeMeta(
  repoId: string,
  worktrees: readonly { path: string }[]
): Record<string, WorktreeMeta> {
  return Object.fromEntries(
    worktrees.map((worktree) => [`${repoId}::${worktree.path}`, makeWorktreeMeta()])
  )
}

describe('OrcaRuntimeService', () => {
  it('keeps a hook row with an unresolvable pane key', async () => {
    // Without tabId, local staleness is unprovable.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'opaque-key-without-structure',
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'unattributable pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'unattributable pane' })])
  })

  it('keeps a WSL hook row while its tab is still in the session', async () => {
    // Local-tab evidence must also rescue WSL rows.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'open-wsl-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'open-wsl-tab:99999999-9999-4999-8999-999999999997',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'open-wsl-tab',
          state: 'working',
          prompt: 'live in WSL',
          agentType: 'codex',
          connectionId: 'wsl:Ubuntu',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'live in WSL' })])
  })

  it('drops a hydrated WSL hook row after its local tab is closed', async () => {
    // A WSL relay id names the transport, not a remote pane.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-wsl-tab:99999999-9999-4999-8999-999999999999',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'closed-wsl-tab',
          state: 'done',
          prompt: 'finished in WSL',
          agentType: 'codex',
          connectionId: 'wsl:Ubuntu',
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([])
  })

  it('keeps remote hook rows whose tabs are only tracked on the remote host', async () => {
    // An empty local session partition does not prove an SSH host's pane closed.
    const remoteRepo = {
      id: 'repo-ssh-6072',
      path: '/home/me/project',
      displayName: 'remote-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-6072'
    }
    const remoteWorktree = {
      path: '/home/me/project/.worktrees/feature-agents',
      head: 'def',
      branch: 'refs/heads/feature/agents',
      isBare: false,
      isMainWorktree: false
    }
    const remoteWorktreeId = `${remoteRepo.id}::${remoteWorktree.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [remoteWorktreeId]: makeWorktreeMeta({ displayName: 'Remote agents' })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => getDefaultWorkspaceSession()
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'remote-tab:88888888-8888-4888-8888-888888888888',
          worktreeId: remoteWorktreeId,
          tabId: 'remote-tab',
          state: 'working',
          prompt: 'remote agent without local tab records',
          agentType: 'codex',
          connectionId: 'ssh-6072',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === remoteWorktreeId)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ prompt: 'remote agent without local tab records' })
    ])
  })

  it('keeps no-PTY agent worktrees in the truncated mobile summary', async () => {
    const remoteRepo = {
      id: 'repo-truncated-ssh',
      path: '/remote',
      displayName: 'truncated-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-truncated'
    }
    const targetPath = '/remote/zzz-live-agent'
    const remoteWorktrees = [
      ...Array.from({ length: 200 }, (_, index) => ({
        path: `/remote/inactive-${String(index).padStart(3, '0')}`,
        head: `head-${index}`,
        branch: `refs/heads/inactive-${index}`,
        isBare: false,
        isMainWorktree: false
      })),
      {
        path: targetPath,
        head: 'live-agent',
        branch: 'refs/heads/live-agent',
        isBare: false,
        isMainWorktree: false
      }
    ]
    const storedMeta = storedWorktreeMeta(remoteRepo.id, remoteWorktrees)
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => storedMeta,
      getWorktreeMeta: () => undefined
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'truncated-tab:77777777-7777-4777-8777-777777777777',
          worktreeId: `${remoteRepo.id}::${targetPath}/`,
          tabId: 'truncated-tab',
          state: 'working',
          prompt: 'live beyond the default limit',
          agentType: 'codex',
          connectionId: 'ssh-truncated',
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const summaries = await runtime.getWorktreePs()
    const target = summaries.worktrees.find((worktree) => worktree.path === targetPath)

    expect(summaries).toMatchObject({ totalCount: 201, truncated: true })
    expect(summaries.worktrees).toHaveLength(200)
    expect(target).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
    expect(target?.agents).toHaveLength(1)
  })
})
