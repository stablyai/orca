import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status-subject'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  scanLocalRepoWorktreesForResolutionMock
} from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'
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
const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: TEST_WORKTREE_ID,
    workspaceKind: 'git-worktree'
  },
  SESSION
)

/**
 * Why describe-scoped: a top-level hook in this file would register on the whole root
 * suite of the aggregating orca-runtime.test.ts, overwriting the shared scan mock that
 * resetRuntimeTestMocks delegates to listWorktrees — the scan-cache suites count those
 * calls, so they would all see zero scans. Scoped here, only these cases pay for it.
 */
describe('worktree ps structured host', () => {
  beforeEach(() => {
    _internals.resetCachesForTests()
    // The scan mock ships unconfigured, so without this the resolved-worktree snapshot is empty
    // and every case here lists nothing. Same inventory the fixture store declares.
    scanLocalRepoWorktreesForResolutionMock.mockResolvedValue({
      ok: true,
      worktrees: MOCK_GIT_WORKTREES
    })
  })

  describe('worktree ps reads structured sessions from the agent-status store', () => {
    it('lists a host-held structured session with no terminal behind it', async () => {
      const statusStore = new AgentHookServer()
      statusStore.ingestStructuredStatus(
        {
          sessionId: SESSION,
          workspaceId: TEST_WORKTREE_ID,
          agent: 'claude',
          status: 'working',
          hostExecutionOwned: true,
          latestPrompt: 'ship the thing',
          updatedAt: 1_757_030_400_000
        },
        SUBJECT
      )
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
      // Null would tell a reader "looked, no wait"; a structured worker has no terminal to look at,
      // so the field must stay absent (same contract as worker-observation.ts).
      expect(worktree?.agents[0]).not.toHaveProperty('agentWait')
      expect(worktree?.status).toBe('working')
      expect(getAgentStatusSnapshot).toHaveBeenCalledTimes(1)
    })

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

  describe('worktree ps resolves pty agent rows through the real sweep', () => {
    /**
     * The wait threading lives behind an `attachRuntimeWorktreeAgentRowWaits(...)` call inside the
     * `@ts-nocheck` assembly above, so the helper suites that compose it by hand stay green if that
     * wiring regresses. These drive a handle-carrying hook row through the production read.
     */
    async function makeRuntimeWithPtyAgentRow(state: 'waiting' | 'working') {
      const statusStore = new AgentHookServer()
      const runtime = new OrcaRuntimeService(store, undefined, {
        getAgentStatusSnapshot: () => statusStore.getStatusSnapshot()
      })
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-ps-agent-wait' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'claude',
        title: 'worker'
      })
      statusStore.ingestTerminalStatus({
        paneKey: makePaneKey('tab-ps-wait', '22222222-2222-4222-8222-222222222222'),
        tabId: 'tab-ps-wait',
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        terminalHandle: handle,
        payload: { state, prompt: 'review the PR', agentType: 'claude' }
      })
      return { runtime, handle }
    }

    it('threads a resolved wait descriptor onto the pty row', async () => {
      const { runtime, handle } = await makeRuntimeWithPtyAgentRow('waiting')
      const getWait = vi.spyOn(runtime, 'getTerminalInteractiveWait').mockResolvedValue({
        source: 'prompt-text',
        reason: 'clarify'
      })

      const { worktrees } = await runtime.getWorktreePs()

      expect(getWait).toHaveBeenCalledWith(handle)
      const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
      expect(worktree?.agents).toHaveLength(1)
      expect(worktree?.agents[0]).toMatchObject({
        state: 'waiting',
        agentWait: { source: 'prompt-text', reason: 'clarify' }
      })
    })

    it('resolves a populated hook wait through the real getter', async () => {
      const { runtime } = await makeRuntimeWithPtyAgentRow('waiting')

      const { worktrees } = await runtime.getWorktreePs()

      const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
      expect(worktree?.agents).toHaveLength(1)
      // No stub anywhere: the row's handle flows through attachRuntimeWorktreeAgentRowWaits into
      // the real getTerminalInteractiveWait, whose hook branch probes the PTY and reports the wait.
      expect(worktree?.agents[0]?.agentWait).toMatchObject({ source: 'hook' })
    })

    it('carries an explicit null when the real getter looks and finds no wait', async () => {
      const { runtime } = await makeRuntimeWithPtyAgentRow('working')

      const { worktrees } = await runtime.getWorktreePs()

      const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
      expect(worktree?.agents).toHaveLength(1)
      // Null means the sweep looked through the terminal and found no wait; only a row whose handle
      // could not be evaluated at all keeps the field absent.
      expect(worktree?.agents[0]?.agentWait).toBeNull()
    })
  })
})
