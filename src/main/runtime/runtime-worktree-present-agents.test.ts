import { describe, expect, it } from 'vitest'
import { attachRuntimeWorktreePresentAgents } from './runtime-worktree-agent-rows'
import type { AgentPaneOwner } from '../../shared/agent-process-presence'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'

const process = { pid: 7, platform: 'linux', startTime: 'boot:7' } as const
function owner(paneKey: string, overrides: Partial<AgentPaneOwner> = {}): AgentPaneOwner {
  return {
    paneKey,
    connectionId: null,
    worktreeId: 'wt-1',
    presence: { agent: 'aider', process },
    receivedAt: 1,
    ...overrides
  }
}

describe('worktree ps agents present without a turn', () => {
  it('lists a live owner beside the turns, and nothing an older reader must understand', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields this projection reads.
    const summary = {
      worktreeId: 'wt-1',
      agents: [{ paneKey: 'tab:turn', state: 'working' }]
    } as unknown as RuntimeWorktreePsSummary
    attachRuntimeWorktreePresentAgents({
      owners: [
        owner('tab:hookless'),
        owner('tab:turn'),
        owner('tab:exited', { presence: { agent: 'codex', process, ended: true } }),
        owner('tab:elsewhere', { worktreeId: 'wt-2' })
      ],
      getSummary: (worktreeId) => (worktreeId === 'wt-1' ? summary : null)
    })
    expect(summary.presentAgents).toEqual([{ paneKey: 'tab:hookless', agentType: 'aider' }])
    expect(summary.agents).toHaveLength(1)
  })
})
