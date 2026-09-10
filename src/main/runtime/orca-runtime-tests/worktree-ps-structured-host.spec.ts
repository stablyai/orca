import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { AgentHookServer, _internals } from '../../agent-hooks/server'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

/**
 * The production read, not the projection. The structured-row suites feed
 * `attachRuntimeWorktreeAgentRows` a snapshot they built themselves; this executes `getWorktreePs`
 * in `orca-runtime-get-worktree-ps.ts`, which is `@ts-nocheck`, so a renamed dependency there stays
 * green in typecheck while `orca worktree ps` and mobile's poll would list nothing.
 */
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe('worktree ps reads structured sessions from the agent-status store', () => {
  it('lists a host-held structured session with no terminal behind it', async () => {
    const statusStore = new AgentHookServer()
    statusStore.ingestStructuredStatus({
      sessionId: SESSION,
      workspaceId: TEST_WORKTREE_ID,
      agent: 'claude',
      status: 'working',
      hostExecutionOwned: true,
      latestPrompt: 'ship the thing',
      updatedAt: 1_757_030_400_000
    })
    const getAgentStatusSnapshot = vi.fn(() => statusStore.getStatusSnapshot())

    const { worktrees } = await new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot
    }).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree).toBeDefined()
    expect(worktree?.agents).toHaveLength(1)
    expect(worktree?.agents[0]).toMatchObject({
      state: 'working',
      agentType: 'claude',
      prompt: 'ship the thing',
      structuredHostOwned: true
    })
    expect(worktree?.status).toBe('working')
    expect(getAgentStatusSnapshot).toHaveBeenCalledTimes(1)
  })

  it('lists nothing once the host has dropped the session', async () => {
    const statusStore = new AgentHookServer()
    statusStore.ingestStructuredStatus({
      sessionId: SESSION,
      workspaceId: TEST_WORKTREE_ID,
      agent: 'claude',
      status: 'attention',
      latestPrompt: 'rm the branch',
      updatedAt: 1_757_030_400_000
    })
    statusStore.dropStructuredStatus(SESSION)

    const { worktrees } = await new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => statusStore.getStatusSnapshot()
    }).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree).toBeDefined()
    expect(worktree?.agents).toEqual([])
    expect(worktree?.status).not.toBe('permission')
  })
})
