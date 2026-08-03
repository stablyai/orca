// Legal state transitions for Audited Workflow tasks (plan §4). This module owns
// ONLY transition legality — actors, preconditions, and evidence-writing live in
// phase-command-service.ts and the phase-specific services built in later phases.
// Phase 1 exercises this exclusively through the dev-build-gated manual transition
// control (ipc/audited-workflow-dev-transitions.ts); real phase commands wire in
// starting Phase 2.

import type { AuditedTaskActor, AuditedTaskState } from '../../shared/audited-workflow-types'

export type AuditedTransitionCommand =
  | 'select'
  | 'triage'
  | 'triageAutoPlan'
  | 'triageAutoDirect'
  | 'triageBlock'
  | 'planComplete'
  | 'planReviewApprove'
  | 'planReviewFixesRequested'
  | 'planReviewBlock'
  | 'revisePlan'
  | 'implement'
  | 'implementComplete'
  | 'implementBlock'
  | 'cancelImplementation'
  | 'codeAuditApprove'
  | 'codeAuditFixesRequested'
  | 'codeAuditBlock'
  | 'fix'
  | 'commitAuthorize'
  | 'commitComplete'
  | 'commitBlock'
  | 'land'
  | 'landSucceed'
  | 'landRefuse'
  | 'blockFromInvariantViolation'
  | 'retry'
  | 'resumeAttempt'
  | 'cancel'

export type AuditedTransitionRule = {
  command: AuditedTransitionCommand
  from: readonly AuditedTaskState[]
  to: AuditedTaskState
  actor: AuditedTaskActor
  // Whether `to` is allowed to equal `from` — only true for approve/revoke-style
  // commands that record evidence without changing state (see plan §4 note on 18/19).
  sameStateAllowed?: boolean
}

// One row per numbered transition in plan §4. `blocked` is reachable from every
// non-terminal state via `blockFromInvariantViolation`, encoded separately below
// rather than duplicated per rule.
const TRANSITION_RULES: readonly AuditedTransitionRule[] = [
  { command: 'select', from: [], to: 'selected', actor: 'human' },
  { command: 'triage', from: ['selected'], to: 'triaging', actor: 'control' },
  { command: 'triageAutoPlan', from: ['triaging'], to: 'planning', actor: 'triage' },
  { command: 'triageAutoDirect', from: ['triaging'], to: 'ready_to_implement', actor: 'triage' },
  { command: 'triageBlock', from: ['triaging'], to: 'blocked', actor: 'control' },
  { command: 'planComplete', from: ['planning'], to: 'awaiting_plan_review', actor: 'claude' },
  {
    command: 'planReviewApprove',
    from: ['awaiting_plan_review'],
    to: 'ready_to_implement',
    actor: 'codex'
  },
  {
    command: 'planReviewFixesRequested',
    from: ['awaiting_plan_review'],
    to: 'plan_fixes_requested',
    actor: 'codex'
  },
  { command: 'planReviewBlock', from: ['awaiting_plan_review'], to: 'blocked', actor: 'control' },
  {
    command: 'revisePlan',
    from: ['plan_fixes_requested'],
    to: 'awaiting_plan_review',
    actor: 'claude'
  },
  { command: 'implement', from: ['ready_to_implement'], to: 'implementing', actor: 'control' },
  {
    command: 'implementComplete',
    from: ['implementing'],
    to: 'awaiting_code_audit',
    actor: 'claude'
  },
  { command: 'implementBlock', from: ['implementing'], to: 'blocked', actor: 'control' },
  // Human cancellation of a running direct implementation. UNDOES `implement`
  // rather than advancing: `implementing` is reserved for a live run and for
  // pre_block_state, never a resting state. Without this rule a cancelled direct
  // run would strand — startExecution admits only ready_to_implement, so Start
  // would be refused forever. Plan-mode cancel needs no rule (planning ->
  // planning is a no-op on the state column).
  {
    command: 'cancelImplementation',
    from: ['implementing'],
    to: 'ready_to_implement',
    actor: 'human'
  },
  {
    command: 'codeAuditApprove',
    from: ['awaiting_code_audit'],
    to: 'awaiting_human_approval',
    actor: 'codex'
  },
  {
    command: 'codeAuditFixesRequested',
    from: ['awaiting_code_audit'],
    to: 'code_fixes_requested',
    actor: 'codex'
  },
  { command: 'codeAuditBlock', from: ['awaiting_code_audit'], to: 'blocked', actor: 'control' },
  { command: 'fix', from: ['code_fixes_requested'], to: 'awaiting_code_audit', actor: 'claude' },
  {
    command: 'commitAuthorize',
    from: ['awaiting_human_approval'],
    to: 'committing',
    actor: 'human'
  },
  { command: 'commitComplete', from: ['committing'], to: 'committed', actor: 'control' },
  { command: 'commitBlock', from: ['committing'], to: 'blocked', actor: 'control' },
  { command: 'land', from: ['committed'], to: 'landing', actor: 'human' },
  { command: 'landSucceed', from: ['landing'], to: 'landed', actor: 'control' },
  { command: 'landRefuse', from: ['landing'], to: 'committed', actor: 'control' },
  // 'retry' is intentionally absent here — its target state (pre_block_state)
  // is dynamic, not a fixed union member, so it is validated separately by
  // validateRetryTransition below rather than through TRANSITION_RULES.
  {
    command: 'resumeAttempt',
    from: ['blocked'],
    to: 'committing',
    actor: 'human'
  },
  { command: 'cancel', from: [], to: 'cancelled', actor: 'human' } // `from` validated dynamically: any non-terminal state
]

export const TERMINAL_STATES: readonly AuditedTaskState[] = ['landed', 'cancelled']

export type TransitionValidationResult =
  | { ok: true; rule: AuditedTransitionRule }
  | { ok: false; reasonCode: 'illegal_transition' | 'unknown_command' | 'terminal_state' }

/**
 * Validate whether `command` may transition a task currently in `fromState`.
 * Pure and side-effect-free; callers persist the resulting transition themselves.
 */
export function validateAuditedTransition(
  command: AuditedTransitionCommand,
  fromState: AuditedTaskState | null
): TransitionValidationResult {
  if (command === 'cancel') {
    if (fromState !== null && TERMINAL_STATES.includes(fromState)) {
      return { ok: false, reasonCode: 'terminal_state' }
    }
    return {
      ok: true,
      rule: { command: 'cancel', from: [], to: 'cancelled', actor: 'human' }
    }
  }

  if (command === 'select') {
    if (fromState !== null) {
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    return { ok: true, rule: TRANSITION_RULES.find((r) => r.command === 'select')! }
  }

  if (command === 'retry') {
    // 'retry' has a dynamic target (pre_block_state), never a fixed union
    // member — validate it only through validateRetryTransition, which takes
    // the resolved target explicitly. Routing it through this generic path
    // (which has no way to know pre_block_state) is always an error.
    return { ok: false, reasonCode: 'unknown_command' }
  }

  const rule = TRANSITION_RULES.find((r) => r.command === command)
  if (!rule) {
    return { ok: false, reasonCode: 'unknown_command' }
  }
  if (fromState !== null && TERMINAL_STATES.includes(fromState)) {
    return { ok: false, reasonCode: 'terminal_state' }
  }
  if (fromState === null || !rule.from.includes(fromState)) {
    return { ok: false, reasonCode: 'illegal_transition' }
  }
  return { ok: true, rule }
}

/**
 * `blockFromInvariantViolation` is legal from any non-terminal, non-null state
 * (plan §4, row 26) — validated separately since its `from` set is "everything
 * except terminal states" rather than a fixed list.
 */
export function validateBlockTransition(
  fromState: AuditedTaskState | null
): TransitionValidationResult {
  if (fromState === null || TERMINAL_STATES.includes(fromState)) {
    return { ok: false, reasonCode: 'illegal_transition' }
  }
  return {
    ok: true,
    rule: {
      command: 'blockFromInvariantViolation',
      from: [fromState],
      to: 'blocked',
      actor: 'control'
    }
  }
}

/**
 * `retry` (plan §4, row 27) moves a `blocked` task back to its recorded
 * `preBlockState`. The target is dynamic, so the caller resolves it from
 * persisted state and passes it here rather than relying on a fixed rule.
 */
export function validateRetryTransition(
  fromState: AuditedTaskState | null,
  preBlockState: AuditedTaskState | null
): TransitionValidationResult {
  if (fromState !== 'blocked') {
    return { ok: false, reasonCode: 'illegal_transition' }
  }
  if (preBlockState === null || TERMINAL_STATES.includes(preBlockState)) {
    return { ok: false, reasonCode: 'illegal_transition' }
  }
  return {
    ok: true,
    rule: { command: 'retry', from: ['blocked'], to: preBlockState, actor: 'human' }
  }
}

export function isTerminalState(state: AuditedTaskState): boolean {
  return TERMINAL_STATES.includes(state)
}
