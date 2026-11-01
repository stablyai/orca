import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'

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
  it('keeps the running main turn when the side chat idles the title', () => {
    const hookAt = Date.now() - 10_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      runningExec(hookAt, 'codex'),
      sideChatIdlePty(hookAt)
    )
    expect(out).toMatchObject({ state: 'working', prompt: 'main task please' })
  })

  it('keeps a main turn waiting on approval and its prompt once the side chat closes', () => {
    const hookAt = Date.now() - 20_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      {
        ...runningExec(hookAt, 'codex'),
        state: 'waiting',
        mainAgent: { state: 'waiting', stateStartedAt: hookAt }
      },
      {
        ...sideChatIdlePty(hookAt),
        lastOscTitle: '✋ repo',
        lastOscTitleEpochMs: hookAt + 15_000,
        lastAgentStatus: 'permission',
        lastAgentStatusStartedAtEpochMs: hookAt + 15_000,
        lastAgentStatusRichInvalidatedAtEpochMs: hookAt + 15_000
      }
    )
    expect(out).toMatchObject({ state: 'waiting', prompt: 'main task please' })
  })

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

describe('paired/mobile waiting permission prompts exceeding staleness timeout (#37039)', () => {
  const ASK_PROMPT = JSON.stringify({ approval: { tool: 'Bash', summary: 'gh pr comment' } })

  it('preserves interactivePrompt when waiting on an idle PTY past 30 minutes', () => {
    const hookAt = Date.now() - 50 * 60 * 1000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      {
        ...runningExec(hookAt, 'claude'),
        state: 'waiting',
        interactivePrompt: ASK_PROMPT
      },
      sideChatIdlePty(hookAt)
    )
    expect(out?.state).toBe('waiting')
    expect(out?.interactivePrompt).toBe(ASK_PROMPT)
  })

  it('preserves interactivePrompt, toolName, and toolInput under permission title past 30 minutes', () => {
    const hookAt = Date.now() - 60 * 60 * 1000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      {
        ...runningExec(hookAt, 'claude'),
        state: 'blocked',
        interactivePrompt: ASK_PROMPT
      },
      {
        ...sideChatIdlePty(hookAt),
        lastOscTitle: '✋ repo',
        lastOscTitleEpochMs: hookAt + 15_000,
        lastAgentStatus: 'permission',
        lastAgentStatusStartedAtEpochMs: hookAt + 15_000,
        lastAgentStatusRichInvalidatedAtEpochMs: hookAt + 15_000
      }
    )
    expect(out?.state).toBe('blocked')
    expect(out?.interactivePrompt).toBe(ASK_PROMPT)
    expect(out?.toolName).toBe('Bash')
  })

  it('retires interactivePrompt once PTY title transitions to working', () => {
    const hookAt = Date.now() - 50 * 60 * 1000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      {
        ...runningExec(hookAt, 'claude'),
        state: 'waiting',
        interactivePrompt: ASK_PROMPT
      },
      {
        ...sideChatIdlePty(hookAt),
        lastOscTitle: 'repo',
        lastOscTitleEpochMs: Date.now() - 1000,
        lastAgentStatus: 'working',
        lastAgentStatusStartedAtEpochMs: Date.now() - 1000,
        lastAgentStatusRichInvalidatedAtEpochMs: Date.now() - 1000
      }
    )
    expect(out?.state).toBe('working')
    expect(out?.interactivePrompt).toBeUndefined()
  })
})
