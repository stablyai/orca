import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import {
  demoteRuntimeMobileAgentStatus,
  renewRuntimeMobileAgentStatusFromPtyTitle
} from './runtime-mobile-agent-status-projection'
import { makeTuiIdlePty } from '../../terminal/wait/tui-idle-wait-test-harness'

const titleChangedAt = 1_700_000_000_000

function hookStatus(
  state: AgentStatusEntry['state'],
  at: number,
  prompt = 'Turn 2: reply with only the word OK.'
): AgentStatusEntry {
  return {
    state,
    prompt,
    updatedAt: at,
    stateStartedAt: at,
    agentType: 'claude',
    paneKey: 'tab-1:leaf-1',
    stateHistory: []
  }
}

// Clients keep a row only while nothing newer replaces it, so each frame must outsort the last.
describe('title-only status frames are stamped at the PTY status transition', () => {
  it('stamps the done at the idle transition when the idle title text did not change this turn', () => {
    // Claude repaints the same idle title every turn, so the title clock stays at the first turn.
    const previousWorking = titleChangedAt + 60_000
    const stopAt = titleChangedAt + 120_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      hookStatus('done', stopAt),
      makeTuiIdlePty({
        lastOscTitle: '✳ Claude Code',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: stopAt + 30,
        lastAgentStatusRichInvalidatedAtEpochMs: stopAt + 30
      })
    )
    expect(out?.state).toBe('done')
    expect(out!.updatedAt).toBeGreaterThan(previousWorking)
    expect(out!.updatedAt).toBeGreaterThanOrEqual(stopAt)
  })

  it('stamps a previous turn hook done at a newer idle transition', () => {
    const previousDone = titleChangedAt - 60_000
    const idleAt = titleChangedAt + 5_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      hookStatus('done', previousDone),
      makeTuiIdlePty({
        lastOscTitle: '✳ Claude Code',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: idleAt,
        lastAgentStatusRichInvalidatedAtEpochMs: idleAt
      })
    )
    expect(out).toMatchObject({ state: 'done', updatedAt: idleAt, prompt: '' })
  })

  it('sorts a status-only working after the hook done it follows', () => {
    const doneAt = titleChangedAt + 120_000
    const workingAt = doneAt + 10_000
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      hookStatus('done', doneAt),
      makeTuiIdlePty({
        lastOscTitle: '✳ Claude Code',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'working',
        lastAgentStatusStartedAtEpochMs: workingAt,
        lastAgentStatusRichInvalidatedAtEpochMs: workingAt
      })
    )
    expect(out).toMatchObject({ state: 'working', updatedAt: workingAt })
  })

  it('dates a shell-title demotion at the idle transition, not the older shell title', () => {
    const workingAt = titleChangedAt + 60_000
    const idleAt = titleChangedAt + 90_000
    const out = demoteRuntimeMobileAgentStatus(
      hookStatus('working', workingAt),
      makeTuiIdlePty({
        lastOscTitle: 'zsh',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: idleAt
      })
    )
    expect(out).toMatchObject({ state: 'done', updatedAt: idleAt })
  })

  it('dates a shell-title demotion no earlier than the hook status it replaces', () => {
    const idleAt = titleChangedAt + 90_000
    const hookWorkingAt = idleAt + 5_000
    const out = demoteRuntimeMobileAgentStatus(
      hookStatus('working', hookWorkingAt),
      makeTuiIdlePty({
        lastOscTitle: 'zsh',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: idleAt
      })
    )
    expect(out).toMatchObject({ state: 'done', updatedAt: hookWorkingAt })
  })

  it('stamps the no-hook fallback at the idle transition, not the older title', () => {
    const idleAt = titleChangedAt + 90_000
    const out = buildRuntimeMobileAgentStatus(
      makeTuiIdlePty({
        lastOscTitle: '✳ Claude Code',
        lastOscTitleEpochMs: titleChangedAt,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: idleAt
      }),
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: 'Terminal',
        isActive: true
      },
      null,
      null,
      () => [],
      { getPaneKey: () => 'tab-1:leaf-1', getLeaf: () => null, getTrackedTitle: () => null }
    )
    expect(out.agentStatus).toMatchObject({ state: 'done', updatedAt: idleAt })
  })
})
