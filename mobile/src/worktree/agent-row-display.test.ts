import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentDisplayLabel,
  agentDotState,
  agentIdentityLabel,
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

  it('reports interrupted regardless of state', () => {
    expect(agentDotState(row({ state: 'done', interrupted: true }), 0)).toBe('interrupted')
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
    // 'done' never decays; interrupted still wins.
    expect(agentDotState(row({ state: 'done', updatedAt: 0 }), stale)).toBe('done')
    expect(agentDotState(row({ state: 'working', updatedAt: 0, interrupted: true }), stale)).toBe(
      'interrupted'
    )
  })

  it('keeps a host-owned structured row active past the window', () => {
    // The structured session host still runs this row's provider child, so silence is not
    // evidence it stopped. Mobile ignored `structuredHostOwned` before the decay was shared
    // and decayed this row to idle while the desktop kept it.
    const stale = AGENT_STATUS_STALE_AFTER_MS + 1
    expect(
      agentDotState(row({ state: 'working', updatedAt: 0, structuredHostOwned: true }), stale)
    ).toBe('working')
    expect(
      agentDotState(
        row({
          state: 'working',
          workingMode: 'monitoring',
          updatedAt: 0,
          structuredHostOwned: true
        }),
        stale
      )
    ).toBe('monitoring')
    expect(
      agentDotState(row({ state: 'blocked', updatedAt: 0, structuredHostOwned: true }), stale)
    ).toBe('blocked')
    // The exemption is the owned flag, not the age: an unowned row of the same age still decays.
    expect(agentDotState(row({ state: 'working', updatedAt: 0 }), stale)).toBe('idle')
  })

  it('never shows a hydrated unconfirmed row as active, however recent', () => {
    // A restored row may describe a turn that ended while nothing was listening. Today's host
    // filters these out before they reach the wire, so this pins the contract, not a live path.
    expect(
      agentDotState(row({ state: 'working', updatedAt: 0, restoredUnconfirmed: true }), 1)
    ).toBe('idle')
    expect(
      agentDotState(row({ state: 'blocked', updatedAt: 0, restoredUnconfirmed: true }), 1)
    ).toBe('idle')
  })

  it('degrades to the plain window for a row from an older host', () => {
    // An older host sends neither `structuredHostOwned` nor any evidence stamp. Absence must
    // mean the ordinary updatedAt window — never "fresh", and never a throw.
    const oldHostRow = row({ state: 'working', updatedAt: 0 })
    expect(oldHostRow.structuredHostOwned).toBeUndefined()
    expect(agentDotState(oldHostRow, AGENT_STATUS_STALE_AFTER_MS)).toBe('working')
    expect(agentDotState(oldHostRow, AGENT_STATUS_STALE_AFTER_MS + 1)).toBe('idle')
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
