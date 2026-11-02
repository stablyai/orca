import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'

// Claude repaints the same idle title every turn, so lastOscTitleEpochMs stays at the first turn's value.
describe('paired/mobile done status when the idle title text did not change this turn', () => {
  it('keeps the hook done newer than the previous working instead of restamping it with the stale title time', () => {
    const titleChangedAt = 1_700_000_000_000
    const stopAt = titleChangedAt + 120_000
    const hookDone: AgentStatusEntry = {
      state: 'done',
      prompt: 'Turn 2: reply with only the word OK.',
      updatedAt: stopAt,
      stateStartedAt: stopAt,
      agentType: 'claude',
      paneKey: 'tab-1:leaf-1',
      stateHistory: []
    }
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      hookDone,
      makeTuiIdlePty({
        worktreeId: 'wt-1',
        lastOscTitle: '✳ Claude Code',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: stopAt + 30,
        lastAgentStatusRichInvalidatedAtEpochMs: stopAt + 30
      })
    )
    expect(out).toMatchObject({ state: 'done', updatedAt: stopAt, prompt: hookDone.prompt })
  })

  it('still restamps done from the title when the idle title is newer than the hook', () => {
    const hookAt = 1_700_000_000_000
    const idleAt = hookAt + 30_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      {
        state: 'done',
        prompt: 'earlier turn',
        updatedAt: hookAt,
        stateStartedAt: hookAt,
        agentType: 'claude',
        paneKey: 'tab-1:leaf-1',
        stateHistory: []
      },
      makeTuiIdlePty({
        worktreeId: 'wt-1',
        lastOscTitle: '✳ Claude Code',
        lastOscTitleEpochMs: idleAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: idleAt,
        lastAgentStatusRichInvalidatedAtEpochMs: idleAt
      })
    )
    expect(out).toMatchObject({ state: 'done', updatedAt: idleAt })
  })
})
