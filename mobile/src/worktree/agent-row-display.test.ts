import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  agentMainAgentVerdict,
  agentVerdictDisplayMark
} from '../../../src/shared/agent-main-agent-verdict'
import { AGENT_TURN_OUTCOMES } from '../../../src/shared/agent-turn-outcome'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentDisplayLabel,
  agentDotState,
  agentIdentityLabel,
  agentRowTimeAt,
  agentRowVerdict,
  agentRowVerdictMark,
  formatTimeAgo
} from './agent-row-display'

type Outcome = (typeof AGENT_TURN_OUTCOMES)[number]
const mainAgentDone = (outcome: Outcome, stateStartedAt = 0) => ({
  mainAgent: { state: 'done' as const, outcome, stateStartedAt }
})

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

  it("reports the verdict of a done row: failed, or a user's Stop (also an old host's flag) as interrupted", () => {
    expect(agentDotState(row({ state: 'done', interrupted: true }), 0)).toBe('interrupted')
    expect(agentDotState(row({ state: 'done', ...mainAgentDone('failure') }), 0)).toBe('failed')
    expect(
      agentDotState(row({ state: 'done', ...mainAgentDone('cancellation'), interrupted: true }), 0)
    ).toBe('interrupted')
    expect(agentDotState(row({ state: 'done', ...mainAgentDone('success') }), 0)).toBe('done')
    // A turn a newer request replaced reads as a Stop does.
    expect(agentDotState(row({ state: 'done', ...mainAgentDone('superseded') }), 0)).toBe(
      'interrupted'
    )
  })

  // A crash, quit or restart cut it short: the phone reads it interrupted, as desktop does.
  it('reads a crash-cut turn as interrupted and an unproven end as unconfirmed', () => {
    expect(agentDotState(row({ state: 'done', ...mainAgentDone('interruption') }), 0)).toBe(
      'interrupted'
    )
    expect(agentDisplayLabel(row({ state: 'done', ...mainAgentDone('interruption') }), 0)).toBe(
      'Interrupted'
    )
    expect(agentDotState(row({ state: 'done', ...mainAgentDone('unconfirmed') }), 0)).toBe(
      'unconfirmed'
    )
    expect(agentDisplayLabel(row({ state: 'done', ...mainAgentDone('unconfirmed') }), 0)).toBe(
      'Couldn’t confirm'
    )
  })

  // Rows arrive unparsed, so an arm a newer host adds must read as the done it always did.
  it('reads a done row carrying an outcome it cannot name as done', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an arm from a newer host, which the unparsed wire row can carry.
    const future = mainAgentDone('from-a-newer-host' as Outcome)
    expect(agentDotState(row({ state: 'done', ...future }), 0)).toBe('done')
  })

  it('shows a main agent that failed while its subagents still run as failed', () => {
    expect(agentDotState(row({ state: 'working', ...mainAgentDone('failure') }), 0)).toBe('failed')
    expect(agentDotState(row({ state: 'waiting', ...mainAgentDone('failure') }), 0)).toBe('failed')
    // Only a failure outranks live work; a success, a stop or a crash cut with live subagents
    // reads working.
    expect(agentDotState(row({ state: 'working', ...mainAgentDone('interruption') }), 0)).toBe(
      'working'
    )
    expect(agentDotState(row({ state: 'working', ...mainAgentDone('success') }), 0)).toBe('working')
    expect(
      agentDotState(
        row({ state: 'working', ...mainAgentDone('cancellation'), interrupted: true }),
        0
      )
    ).toBe('working')
  })

  // The shared accessor cannot be imported by app code here, so this mirror must not drift from it.
  it('agrees with the desktop verdict accessor on every row', () => {
    const states = ['working', 'blocked', 'waiting', 'done'] as const
    const mainAgents = [
      undefined,
      ...states.flatMap((state) =>
        [undefined, ...AGENT_TURN_OUTCOMES].map((outcome) => ({
          state,
          ...(outcome ? { outcome } : {}),
          stateStartedAt: 0
        }))
      )
    ]
    for (const state of states) {
      for (const mainAgent of mainAgents) {
        for (const interrupted of [false, true]) {
          const agentRow = { state, interrupted, ...(mainAgent ? { mainAgent } : {}) }
          expect(agentRowVerdict(agentRow), JSON.stringify(agentRow)).toBe(
            agentMainAgentVerdict(agentRow)
          )
          expect(agentRowVerdictMark(agentRow), JSON.stringify(agentRow)).toBe(
            agentVerdictDisplayMark(agentRow)
          )
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
    expect(
      agentDotState(row({ state: 'done', updatedAt: 0, ...mainAgentDone('interruption') }), stale)
    ).toBe('interrupted')
  })
})

describe('agentRowTimeAt', () => {
  it('dates a main agent that failed while its subagents run by its own failure', () => {
    expect(
      agentRowTimeAt(
        row({ state: 'working', stateStartedAt: 100, ...mainAgentDone('failure', 900) })
      )
    ).toBe(900)
  })

  it('dates every other row by when its state began', () => {
    expect(
      agentRowTimeAt(
        row({ state: 'working', stateStartedAt: 100, ...mainAgentDone('success', 900) })
      )
    ).toBe(100)
    expect(
      agentRowTimeAt(row({ state: 'done', stateStartedAt: 100, ...mainAgentDone('failure', 900) }))
    ).toBe(100)
    expect(agentRowTimeAt(row({ state: 'working', stateStartedAt: 100 }))).toBe(100)
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

  it("says Stopping while the host says a person's Stop is ending the turn", () => {
    const stopping = row({
      lastAssistantMessage: 'hello there',
      mainAgent: { state: 'working', stopping: true, stateStartedAt: 0 }
    })
    expect(agentDisplayLabel(stopping, 0)).toBe('Stopping…')
    expect(agentDotState(stopping, 0)).toBe('working')
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
