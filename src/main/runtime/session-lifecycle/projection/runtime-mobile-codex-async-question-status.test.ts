import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import { makeTuiIdlePty } from '../../terminal/wait/tui-idle-wait-test-harness'

const QUESTION = '{"questions":[{"title":"Which database should the probe use?"}]}'

function waitingOnAsyncQuestion(hookAt: number): AgentStatusEntry {
  return {
    state: 'waiting',
    prompt: 'Set up a db',
    updatedAt: hookAt,
    stateStartedAt: hookAt,
    agentType: 'codex',
    toolName: 'request_user_input_async',
    interactivePrompt: QUESTION,
    mainAgent: { state: 'waiting', stateStartedAt: hookAt },
    paneKey: 'tab-1:leaf-1',
    stateHistory: []
  }
}

describe('paired/mobile Codex status while an async question waits', () => {
  it('keeps the question when Codex repaints its working title after the hook', () => {
    const hookAt = 1_700_000_000_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      waitingOnAsyncQuestion(hookAt),
      makeTuiIdlePty({
        lastOscTitle: '⠋ repo',
        lastOscTitleEpochMs: hookAt + 2_000,
        lastAgentStatus: 'working',
        lastAgentStatusStartedAtEpochMs: hookAt - 10_000,
        lastAgentStatusRichInvalidatedAtEpochMs: hookAt - 10_000
      })
    )
    expect(out).toMatchObject({ state: 'waiting', interactivePrompt: QUESTION })
  })
})
