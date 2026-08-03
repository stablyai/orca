// Phase 4 transition wiring: the state-machine rules the execution lanes rely
// on, asserted end-to-end for both modes.
import { describe, expect, it } from 'vitest'
import { validateAuditedTransition } from './audited-workflow-state-machine'
import { AUDITED_TASK_STATES } from '../../shared/audited-workflow-types'

describe('plan lane', () => {
  it('planning -> awaiting_plan_review is legal for the claude actor', () => {
    const result = validateAuditedTransition('planComplete', 'planning')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rule.to).toBe('awaiting_plan_review')
      expect(result.rule.actor).toBe('claude')
    }
  })

  it('planning -> blocked is legal', () => {
    expect(validateAuditedTransition('planReviewBlock', 'awaiting_plan_review').ok).toBe(true)
  })
})

describe('direct lane', () => {
  it('ready_to_implement -> implementing -> awaiting_code_audit is legal', () => {
    const start = validateAuditedTransition('implement', 'ready_to_implement')
    expect(start.ok).toBe(true)
    if (start.ok) {
      expect(start.rule.to).toBe('implementing')
    }

    const finish = validateAuditedTransition('implementComplete', 'implementing')
    expect(finish.ok).toBe(true)
    if (finish.ok) {
      expect(finish.rule.to).toBe('awaiting_code_audit')
    }
  })

  it('implementing -> blocked is legal', () => {
    const result = validateAuditedTransition('implementBlock', 'implementing')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rule.to).toBe('blocked')
    }
  })

  it('implementing -> ready_to_implement is legal ONLY via cancelImplementation', () => {
    expect(validateAuditedTransition('cancelImplementation', 'implementing').ok).toBe(true)
    // No other command reaches ready_to_implement from implementing.
    for (const command of ['implement', 'implementComplete', 'implementBlock'] as const) {
      const result = validateAuditedTransition(command, 'implementing')
      if (result.ok) {
        expect(result.rule.to).not.toBe('ready_to_implement')
      }
    }
  })
})

describe('start admission at the state-machine level', () => {
  it('refuses `implement` from every state except ready_to_implement', () => {
    for (const state of AUDITED_TASK_STATES) {
      if (state === 'ready_to_implement') {
        continue
      }
      expect(validateAuditedTransition('implement', state).ok, `implement from ${state}`).toBe(
        false
      )
    }
  })

  it('refuses `planComplete` from every state except planning', () => {
    for (const state of AUDITED_TASK_STATES) {
      if (state === 'planning') {
        continue
      }
      expect(validateAuditedTransition('planComplete', state).ok).toBe(false)
    }
  })

  it.each(['landed', 'cancelled'] as const)('refuses every start command from %s', (terminal) => {
    for (const command of ['implement', 'planComplete', 'cancelImplementation'] as const) {
      expect(validateAuditedTransition(command, terminal)).toEqual({
        ok: false,
        reasonCode: 'terminal_state'
      })
    }
  })
})
