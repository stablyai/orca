import { makeStructuredAgentStatusSubject } from '../../../../shared/agent-status/contracts/agent-status-subject'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { AgentHookServer, _internals } from '../../../agent-hooks/server/agent-hook-server'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

/** Covers the production status-store read, which a hand-built projection snapshot can bypass. */
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: TEST_WORKTREE_ID,
    workspaceKind: 'git-worktree'
  },
  SESSION
)

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe('worktree ps reads structured sessions from the agent-status store', () => {
  it('lists nothing once the host has dropped the session', async () => {
    const statusStore = new AgentHookServer()
    statusStore.ingestStructuredStatus(
      {
        sessionId: SESSION,
        workspaceId: TEST_WORKTREE_ID,
        agent: 'claude',
        status: 'attention',
        latestPrompt: 'rm the branch',
        updatedAt: 1_757_030_400_000
      },
      SUBJECT
    )
    statusStore.dropStructuredStatus(SUBJECT)

    const { worktrees } = await new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => statusStore.getStatusSnapshot()
    }).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree).toBeDefined()
    expect(worktree?.agents).toEqual([])
    expect(worktree?.status).not.toBe('permission')
  })
})
