import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

// Hook rows with no tab binding and no terminal skip the connected-pty liveness
// gate — their worktreeId is the admitted evidence. The paneKey is deliberately
// unparseable so no tabId resolves.
function hookRow(contextUsage: { usedTokens: number; maxTokens: number }): Record<string, unknown> {
  return {
    paneKey: 'hook-row-without-pane-binding',
    state: 'working',
    prompt: 'compress the diff',
    agentType: 'claude',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    worktreeId: TEST_WORKTREE_ID,
    contextUsage
  }
}

function storeWithSettings(settings: Record<string, unknown>): typeof store {
  return {
    ...store,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      ...settings
    })
  } as typeof store
}

describe('worktree.ps context pressure', () => {
  it('attaches host-computed context pressure to agent rows when the experimental flag is on', async () => {
    const { worktrees } = await new OrcaRuntimeService(
      storeWithSettings({ experimentalContextPressure: true }),
      undefined,
      {
        getAgentStatusSnapshot: () =>
          [hookRow({ usedTokens: 150_000, maxTokens: 200_000 })] as never[]
      }
    ).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree?.agents).toHaveLength(1)
    // Why no usedTokensSource: the reading never named one, so the row omits it.
    expect(worktree?.agents[0]?.contextPressure).toEqual({
      level: 'warning',
      usedPercent: 75,
      usedTokens: 150_000,
      limitTokens: 200_000,
      limitSource: 'provider'
    })
  })

  it('omits context pressure from agent rows when the experimental flag is off', async () => {
    const { worktrees } = await new OrcaRuntimeService(storeWithSettings({}), undefined, {
      getAgentStatusSnapshot: () =>
        [hookRow({ usedTokens: 150_000, maxTokens: 200_000 })] as never[]
    }).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree?.agents).toHaveLength(1)
    expect(worktree?.agents[0]).not.toHaveProperty('contextPressure')
  })

  it('honors custom warning and critical thresholds', async () => {
    const { worktrees } = await new OrcaRuntimeService(
      storeWithSettings({
        experimentalContextPressure: true,
        contextPressureWarnPercent: 80,
        contextPressureCriticalPercent: 95
      }),
      undefined,
      {
        getAgentStatusSnapshot: () =>
          [hookRow({ usedTokens: 150_000, maxTokens: 200_000 })] as never[]
      }
    ).getWorktreePs()

    const worktree = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)
    expect(worktree?.agents[0]?.contextPressure?.level).toBe('ok')
  })
})
