import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { agentMainAgentVerdict } from '../../../src/shared/agent-main-agent-verdict'
import { AGENT_JOURNAL_TURN_OUTCOMES } from '../../../src/shared/agent-turn-outcome'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentDisplayLabel,
  agentDotState,
  agentIdentityLabel,
  agentRowVerdict,
  formatTimeAgo
} from './agent-row-display'

function row(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'p',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('agentDotState', () => {
  it('maps known states through and unknown to idle', () => {
    expect(agentDotState(row({ state: 'working', updatedAt: 0 }), 0)).toBe('working')
    expect(
      agentDotState(row({ state: 'working', workingMode: 'monitoring', updatedAt: 0 }), 0)
    ).toBe('monitoring')
    expect(agentDotState(row({ state: 'blocked', updatedAt: 0 }), 0)).toBe('blocked')
    expect(agentDotState(row({ state: 'waiting', updatedAt: 0 }), 0)).toBe('waiting')
    expect(agentDotState(row({ state: 'done', updatedAt: 0 }), 0)).toBe('done')
    expect(agentDotState(row({ state: 'unknown-state' as never }), 0)).toBe('idle')
  })

  it('reports the verdict of a done row: failed, interrupted, or an old host legacy flag', () => {
    expect(agentDotState(row({ state: 'done', interrupted: true }), 0)).toBe('interrupted')
    expect(agentDotState(row({ state: 'done', outcome: 'failure' }), 0)).toBe('failed')
    expect(
      agentDotState(row({ state: 'done', outcome: 'cancellation', interrupted: true }), 0)
    ).toBe('interrupted')
    expect(agentDotState(row({ state: 'done', outcome: 'success' }), 0)).toBe('done')
  })

  // The shared accessor cannot be imported by app code here, so this mirror must not drift from it.
  it('agrees with the desktop verdict accessor on every row shape', () => {
    for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
      for (const outcome of [undefined, ...AGENT_JOURNAL_TURN_OUTCOMES]) {
        for (const interrupted of [false, true]) {
          const shape = { state, interrupted, ...(outcome ? { outcome } : {}) }
          expect(agentRowVerdict(shape), JSON.stringify(shape)).toBe(agentMainAgentVerdict(shape))
        }
      }
    }
  })

  it('decays a stale active state to idle, matching desktop', () => {
    const stale = AGENT_STATUS_STALE_AFTER_MS + 1
    // Active states past the staleness window read as idle…
    expect(agentDotState(row({ state: 'working', updatedAt: 0 }), stale)).toBe('idle')
    expect(agentDotState(row({ state: 'blocked', updatedAt: 0 }), stale)).toBe('idle')
    expect(agentDotState(row({ state: 'waiting', updatedAt: 0 }), stale)).toBe('idle')
    // …exactly at the threshold it is still fresh (decay is strictly past it).
    expect(
      agentDotState(row({ state: 'working', updatedAt: 0 }), AGENT_STATUS_STALE_AFTER_MS)
    ).toBe('working')
    // 'done' never decays, and neither does its verdict.
    expect(agentDotState(row({ state: 'done', updatedAt: 0 }), stale)).toBe('done')
    expect(agentDotState(row({ state: 'done', updatedAt: 0, interrupted: true }), stale)).toBe(
      'interrupted'
    )
  })
})

describe('agentDisplayLabel', () => {
  it('prefers last message, then prompt, then state label', () => {
    expect(agentDisplayLabel(row({ lastAssistantMessage: 'hello there' }), 0)).toBe('hello there')
    expect(agentDisplayLabel(row({ lastAssistantMessage: '   ', prompt: 'do the thing' }), 0)).toBe(
      'do the thing'
    )
    expect(agentDisplayLabel(row({ state: 'working', prompt: '', updatedAt: 0 }), 0)).toBe(
      'Working'
    )
    expect(
      agentDisplayLabel(
        row({ state: 'working', workingMode: 'monitoring', prompt: '', updatedAt: 0 }),
        0
      )
    ).toBe('Monitoring background tasks')
  })

  it('falls back to the decayed state label when stale', () => {
    expect(
      agentDisplayLabel(
        row({ state: 'working', prompt: '', updatedAt: 0 }),
        AGENT_STATUS_STALE_AFTER_MS + 1
      )
    ).toBe('Idle')
  })
})

describe('agentIdentityLabel', () => {
  it('maps known agent types and falls back to initials', () => {
    expect(agentIdentityLabel('claude')).toBe('CL')
    expect(agentIdentityLabel('codex')).toBe('CX')
    expect(agentIdentityLabel('mystery')).toBe('MY')
    expect(agentIdentityLabel(null)).toBe('')
  })
})

describe('formatTimeAgo', () => {
  const now = 10_000_000
  it('formats across thresholds', () => {
    expect(formatTimeAgo(now - 30_000, now)).toBe('just now')
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe('5m')
    expect(formatTimeAgo(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatTimeAgo(now - 2 * 86_400_000, now)).toBe('2d')
  })
})
