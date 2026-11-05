import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../shared/agent-status/contracts/agent-status-types'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import type { RuntimePtyWorktreeRecord } from './terminal/records/runtime-terminal-state-records'
import { makeTuiIdlePty } from './terminal/wait/tui-idle-wait-test-harness'

// Codex 0.164: idle /side output after a long main-turn PreToolUse hook incorrectly cleared the paired-host spinner.
function runningExec(hookAt: number, agentType: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'main task please',
    updatedAt: hookAt,
    stateStartedAt: hookAt,
    agentType,
    toolName: 'Bash',
    toolInput: 'sleep 60',
    mainAgent: { state: 'working', stateStartedAt: hookAt },
    paneKey: 'tab-1:leaf-1',
    stateHistory: []
  }
}

function sideChatIdlePty(hookAt: number): RuntimePtyWorktreeRecord {
  return makeTuiIdlePty({
    worktreeId: 'wt-1',
    lastOscTitle: 'repo',
    lastOscTitleEpochMs: hookAt + 8_000,
    lastAgentStatus: 'idle',
    lastAgentStatusStartedAtEpochMs: hookAt + 8_000,
    lastAgentStatusRichInvalidatedAtEpochMs: hookAt + 8_000
  })
}

describe('paired/mobile Codex status while a /side chat is shown', () => {
  it('does not carry a running turn across a replacement process on the same PTY', () => {
    const hookAt = Date.now() - 20_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(runningExec(hookAt, 'codex'), {
      ...sideChatIdlePty(hookAt),
      lastOscTitle: null,
      lastOscTitleEpochMs: null,
      lastAgentStatus: null,
      lastAgentStatusStartedAtEpochMs: null,
      lastAgentStatusRichInvalidatedAtEpochMs: hookAt + 5_000,
      providerGenerationResetAtEpochMs: hookAt + 5_000
    })
    expect(out).toBeNull()
  })
})
