import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../construction/test-context/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../construction/test-context/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../construction/test-context/orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`

const SCENARIOS = [
  ['an idle agent with its conversation saved', ['persisted-pty']],
  ['a working agent', []],
  ['a draft typed after the turn ended', []],
  ['a saved record of another conversation', []],
  ['an agent inside tmux', []]
] as const

describe('quit stops idle agents', () => {
  it.each(SCENARIOS)('%s', async (scenario, expectedStopped) => {
    const fixture = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        sleepingAgentSessionsByPaneKey: {
          [PANE_KEY]: {
            paneKey: PANE_KEY,
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'claude',
            providerSession: {
              key: 'session_id',
              id:
                scenario === 'a saved record of another conversation'
                  ? 'claude-session-0'
                  : 'claude-session-1'
            },
            prompt: 'fix the bug',
            state: 'done',
            capturedAt: 300,
            updatedAt: 300,
            origin: 'quit',
            connectionId: null
          }
        }
      })
    )
    const row: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      state: scenario === 'a working agent' ? 'working' : 'done',
      prompt: 'fix the bug',
      agentType: 'claude',
      connectionId: null,
      receivedAt: 200,
      stateStartedAt: 200,
      turnStartedAt: 100,
      tabId: 'host-tab',
      worktreeId: TEST_WORKTREE_ID,
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    }
    const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
      getAgentProviderSessionSnapshot: () => [row],
      getPaneAgentIdentity: () => ({
        status: row,
        ended: false,
        processTopology: scenario === 'an agent inside tmux' ? 'shared' : 'pane-owned'
      })
    })
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'claude' }]
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'persisted-pty'
        }
      ]
    })
    // Prompt submitted before the turn opened; only the draft case types after it ended.
    runtime.terminalRunFacts.recordInput('persisted-pty', 'driving', 'fix the bug\r', 90)
    if (scenario === 'a draft typed after the turn ended') {
      runtime.terminalRunFacts.recordInput('persisted-pty', 'driving', 'and then', 250)
    }

    const stopped = await runtime.stopIdleAgentTerminalsForQuit(Date.now() + 4_000)

    expect(stopped).toEqual(expectedStopped)
    expect(stopAndWait.mock.calls).toEqual(
      expectedStopped.map((ptyId) => [ptyId, { keepHistory: true, deadlineMs: expect.any(Number) }])
    )
  })
})
