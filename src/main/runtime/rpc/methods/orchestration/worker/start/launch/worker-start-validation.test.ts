import { describe, expect, it } from 'vitest'
import { WorkerStartParams } from '../../../../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { prepareLocalWorkerStart } from './worker-start-validation'

function startWithoutAgent(disabledTuiAgents: TuiAgent[]) {
  const runtime = { getClientSettings: () => ({ disabledTuiAgents }) }
  return () =>
    prepareLocalWorkerStart({
      params: WorkerStartParams.parse({ from: 'term_coord', task: 'task_1' }),
      createsWorktree: true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a start with no --agent reads only the disabled agents.
      runtime: runtime as unknown as OrcaRuntimeService
    })
}

describe('worker-start without --agent', () => {
  it("names the agents this host can start, keeping the error's code", () => {
    const disabled = TUI_AGENT_AUTO_PICK_ORDER.filter((id) => id !== 'claude' && id !== 'codex')
    expect(startWithoutAgent(disabled)).toThrow(
      expect.objectContaining({
        code: 'agent_unconfigured',
        message:
          'A configured --agent is required when worker-start creates a terminal. Pass --agent with one of: claude, codex.'
      })
    )
  })

  it('keeps the plain message when every launcher is disabled', () => {
    expect(startWithoutAgent([...TUI_AGENT_AUTO_PICK_ORDER])).toThrow(
      /^A configured --agent is required when worker-start creates a terminal\.$/
    )
  })
})
