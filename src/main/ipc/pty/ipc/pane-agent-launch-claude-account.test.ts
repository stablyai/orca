import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import { claudePinnedLaunchError } from '../../../../shared/claude/claude-pinned-launch-error'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../../../agent-launch/agent-launch-pane-attachment'
import { planQueuedPaneAgentLaunch } from '../pane-agent-launch.test-fixture'
import { endPaneAgentLaunch, type PaneAgentLaunch } from './spawn-agent-launch-end'
import { checkPtyIpcLaunchPane } from './spawn-begin'
import type { PtyIpcSpawnState } from './spawn-state'
import type { AgentPaneLaunchRequest } from '../../../../shared/agent-launch/contracts/agent-pane-launch-request'

const PANE = { worktreeId: 'wt-1', tabId: 'tab-1', leafId: '11111111-1111-4111-8111-111111111111' }
const PANE_KEY = `${PANE.tabId}:${PANE.leafId}`

function refusedLaunchEnd(error: Error): Error | null {
  const stub = {
    runtime: { reportAgentLaunchPaneVerdict: vi.fn() },
    address: PANE,
    paneKey: PANE_KEY,
    running: { finish: vi.fn(), closedByUser: () => false },
    dispatched: false,
    refuseIfClosed: () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endPaneAgentLaunch reads only these members of the launch and the state.
  const ctx = { paneAgentLaunch: stub as unknown as PaneAgentLaunch } as PtyIpcSpawnState
  return endPaneAgentLaunch(ctx, { error })
}

function launchPaneSpawn(
  agentLaunch: Pick<AgentPaneLaunchRequest, 'replacesRefusedLaunch'>
): PtyIpcSpawnState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission check reads only args and the optional runtime and store.
  return {
    args: { ...PANE, agentLaunch },
    deps: {},
    paneSpawnReservation: null
  } as unknown as PtyIpcSpawnState
}

afterEach(() => {
  resetAgentLaunchPanesForTests()
})

describe('a launch pane refused for its pinned Claude account', () => {
  it('reports the refusal itself, so the pane can offer the active account', () => {
    expect(
      refusedLaunchEnd(claudePinnedLaunchError('account-missing', 'Gone.'))?.message
    ).toContain('[claude_pinned:account-missing]')
    expect(refusedLaunchEnd(new Error('boom'))?.message).toBe(AGENT_LAUNCH_PANE_REFUSED_CODE)
  })

  it('lets the retry replace the refused launch, but keeps other spawns out', async () => {
    trackRunningAgentLaunchPane({ worktreeId: PANE.worktreeId, paneKey: PANE_KEY }).finish({
      kind: 'not-started',
      code: 'refused'
    })
    await expect(checkPtyIpcLaunchPane(launchPaneSpawn({}))).rejects.toThrow(
      AGENT_LAUNCH_PANE_REFUSED_CODE
    )
    await expect(
      checkPtyIpcLaunchPane(launchPaneSpawn({ replacesRefusedLaunch: true }))
    ).resolves.toBeUndefined()
  })

  it("keeps the retry's active-account choice through the host's plan", async () => {
    const planned = await planQueuedPaneAgentLaunch(
      { launch: { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-1' } } },
      {},
      PANE,
      {
        launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: ACTIVE_CLAUDE_ACCOUNT }
      }
    )

    expect(planned.launchConfig?.claudeAccountId).toBe(ACTIVE_CLAUDE_ACCOUNT)
  })
})
