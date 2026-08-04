import { describe, expect, it } from 'vitest'
import {
  isTerminalState,
  validateAuditedTransition,
  validateBlockTransition,
  validateRetryTransition,
  TERMINAL_STATES,
  type AuditedTransitionCommand
} from './audited-workflow-state-machine'
import { AUDITED_TASK_STATES, type AuditedTaskState } from '../../shared/audited-workflow-types'

// One legal transition per row of plan §4's numbered table (excluding
// 'retry', which has a dynamic target and is tested separately).
const LEGAL_TRANSITIONS: {
  command: AuditedTransitionCommand
  from: AuditedTaskState
  to: AuditedTaskState
}[] = [
  { command: 'select', from: null as unknown as AuditedTaskState, to: 'selected' },
  { command: 'triage', from: 'selected', to: 'triaging' },
  { command: 'triageAutoPlan', from: 'triaging', to: 'planning' },
  { command: 'triageAutoDirect', from: 'triaging', to: 'ready_to_implement' },
  { command: 'triageBlock', from: 'triaging', to: 'blocked' },
  { command: 'planComplete', from: 'planning', to: 'awaiting_plan_review' },
  { command: 'planReviewApprove', from: 'awaiting_plan_review', to: 'ready_to_implement' },
  { command: 'planReviewFixesRequested', from: 'awaiting_plan_review', to: 'plan_fixes_requested' },
  { command: 'planReviewBlock', from: 'awaiting_plan_review', to: 'blocked' },
  // Phase 5: a revision is an EXECUTION, so it re-enters `planning`; only
  // planComplete may reach awaiting_plan_review.
  { command: 'revisePlan', from: 'plan_fixes_requested', to: 'planning' },
  { command: 'implement', from: 'ready_to_implement', to: 'implementing' },
  { command: 'implementComplete', from: 'implementing', to: 'awaiting_code_audit' },
  { command: 'implementBlock', from: 'implementing', to: 'blocked' },
  { command: 'cancelImplementation', from: 'implementing', to: 'ready_to_implement' },
  { command: 'codeAuditApprove', from: 'awaiting_code_audit', to: 'awaiting_human_approval' },
  { command: 'codeAuditFixesRequested', from: 'awaiting_code_audit', to: 'code_fixes_requested' },
  { command: 'codeAuditBlock', from: 'awaiting_code_audit', to: 'blocked' },
  { command: 'fix', from: 'code_fixes_requested', to: 'awaiting_code_audit' },
  { command: 'commitAuthorize', from: 'awaiting_human_approval', to: 'committing' },
  { command: 'commitComplete', from: 'committing', to: 'committed' },
  { command: 'commitBlock', from: 'committing', to: 'blocked' },
  { command: 'land', from: 'committed', to: 'landing' },
  { command: 'landSucceed', from: 'landing', to: 'landed' },
  { command: 'landRefuse', from: 'landing', to: 'committed' },
  { command: 'resumeAttempt', from: 'blocked', to: 'committing' }
]

describe('validateAuditedTransition', () => {
  it.each(LEGAL_TRANSITIONS)('$command: $from -> $to is legal', ({ command, from, to }) => {
    const result = validateAuditedTransition(command, from === null ? null : from)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rule.to).toBe(to)
    }
  })

  it('rejects every command from every state it is not listed for (exhaustive negative matrix)', () => {
    const legalPairs = new Set(LEGAL_TRANSITIONS.map((t) => `${t.command}:${t.from}`))
    const commands = LEGAL_TRANSITIONS.map((t) => t.command)
    const states: (AuditedTaskState | null)[] = [null, ...AUDITED_TASK_STATES]

    for (const command of commands) {
      for (const state of states) {
        const key = `${command}:${state}`
        if (legalPairs.has(key)) {
          continue
        }
        const result = validateAuditedTransition(command, state)
        expect(result.ok, `${command} from ${state} must be illegal`).toBe(false)
      }
    }
  })

  it('rejects select from any non-null state', () => {
    for (const state of AUDITED_TASK_STATES) {
      const result = validateAuditedTransition('select', state)
      expect(result.ok).toBe(false)
    }
  })

  it('rejects an unknown command', () => {
    const result = validateAuditedTransition(
      'notACommand' as unknown as AuditedTransitionCommand,
      'selected'
    )
    expect(result).toEqual({ ok: false, reasonCode: 'unknown_command' })
  })

  it('rejects retry through the generic path (dynamic target requires validateRetryTransition)', () => {
    const result = validateAuditedTransition('retry', 'blocked')
    expect(result).toEqual({ ok: false, reasonCode: 'unknown_command' })
  })

  it('rejects any transition attempt from a terminal state', () => {
    for (const terminal of TERMINAL_STATES) {
      const result = validateAuditedTransition('cancel', terminal)
      expect(result).toEqual({ ok: false, reasonCode: 'terminal_state' })
    }
  })
})

// Phase 4 §1. The exhaustive negative matrix above already proves this command
// is illegal from every other state; these cases pin the specific regressions
// the rule exists to prevent.
describe('cancelImplementation', () => {
  it('is a human-actor transition back to the pre-launch state', () => {
    const result = validateAuditedTransition('cancelImplementation', 'implementing')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rule.to).toBe('ready_to_implement')
      expect(result.rule.actor).toBe('human')
    }
  })

  it('refuses a double cancel from the state it restores to', () => {
    expect(validateAuditedTransition('cancelImplementation', 'ready_to_implement')).toEqual({
      ok: false,
      reasonCode: 'illegal_transition'
    })
  })

  it('refuses from a terminal state', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(validateAuditedTransition('cancelImplementation', terminal)).toEqual({
        ok: false,
        reasonCode: 'terminal_state'
      })
    }
  })

  it('refuses from planning — plan-mode cancel is a same-state no-op, not this rule', () => {
    expect(validateAuditedTransition('cancelImplementation', 'planning')).toEqual({
      ok: false,
      reasonCode: 'illegal_transition'
    })
  })
})

describe('cancel', () => {
  it('is legal from every non-terminal state', () => {
    const nonTerminal = AUDITED_TASK_STATES.filter((s) => !TERMINAL_STATES.includes(s))
    for (const state of nonTerminal) {
      const result = validateAuditedTransition('cancel', state)
      expect(result.ok).toBe(true)
    }
  })

  it('is illegal from a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      const result = validateAuditedTransition('cancel', state)
      expect(result).toEqual({ ok: false, reasonCode: 'terminal_state' })
    }
  })
})

describe('validateBlockTransition', () => {
  it('is legal from every non-terminal, non-null state', () => {
    const nonTerminal = AUDITED_TASK_STATES.filter((s) => !TERMINAL_STATES.includes(s))
    for (const state of nonTerminal) {
      const result = validateBlockTransition(state)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rule.to).toBe('blocked')
      }
    }
  })

  it('is illegal from null or a terminal state', () => {
    expect(validateBlockTransition(null).ok).toBe(false)
    for (const state of TERMINAL_STATES) {
      expect(validateBlockTransition(state).ok).toBe(false)
    }
  })
})

describe('validateRetryTransition', () => {
  it('restores the recorded pre-block state', () => {
    const result = validateRetryTransition('blocked', 'implementing')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rule.to).toBe('implementing')
    }
  })

  it('is illegal when not currently blocked', () => {
    expect(validateRetryTransition('implementing', 'selected').ok).toBe(false)
  })

  it('is illegal when pre-block state is missing', () => {
    expect(validateRetryTransition('blocked', null).ok).toBe(false)
  })

  it('is illegal when pre-block state is itself terminal', () => {
    expect(validateRetryTransition('blocked', 'landed').ok).toBe(false)
    expect(validateRetryTransition('blocked', 'cancelled').ok).toBe(false)
  })
})

describe('isTerminalState', () => {
  it('classifies landed and cancelled as terminal, everything else as non-terminal', () => {
    for (const state of AUDITED_TASK_STATES) {
      expect(isTerminalState(state)).toBe(state === 'landed' || state === 'cancelled')
    }
  })
})
