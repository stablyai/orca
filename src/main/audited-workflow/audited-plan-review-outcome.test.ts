// Fail-closed outcome rules. The single property that matters most: no process
// outcome other than a clean exit with a successfully parsed verdict can produce
// `approved`, and drift always wins.
import { describe, expect, it } from 'vitest'
import { decidePlanReviewOutcome } from './audited-plan-review-outcome'
import type { CodexProcessOutcome } from './audited-codex-process'
import type { PlanAuditVerdictParseResult } from './audited-plan-audit-verdict'

const CLEAN_EXIT: CodexProcessOutcome = {
  kind: 'exit',
  exitCode: 0,
  stdout: 'banner noise',
  stderr: ''
}

const APPROVED: PlanAuditVerdictParseResult = {
  ok: true,
  verdict: 'approved',
  summary: 'ok',
  findingCount: 0,
  coverage: []
}

describe('decidePlanReviewOutcome — process failures', () => {
  it.each([
    ['not_found', 'codex_not_found', 'codex_not_found'],
    ['launch_plan_invalid', 'launch_plan_invalid', 'plan_review_process_failed'],
    ['spawn_failed', 'spawn_failed', 'plan_review_process_failed']
  ])('blocks on %s', (kind, reasonCode, blockedReasonCode) => {
    const decision = decidePlanReviewOutcome({
      outcome: { kind } as CodexProcessOutcome,
      driftReasonCode: null,
      coverage: [],
      parsed: null
    })
    expect(decision).toMatchObject({
      status: 'failed',
      reasonCode,
      blockedReasonCode,
      toState: 'blocked',
      preBlockState: 'awaiting_plan_review',
      verdict: null
    })
  })

  it('blocks on timeout', () => {
    const decision = decidePlanReviewOutcome({
      outcome: { kind: 'timeout', stdout: '', stderr: '' },
      driftReasonCode: null,
      coverage: [],
      parsed: null
    })
    expect(decision).toMatchObject({ reasonCode: 'timeout', blockedReasonCode: 'agent_timeout' })
  })

  it('blocks on output overflow', () => {
    const decision = decidePlanReviewOutcome({
      outcome: { kind: 'output_too_large', stdout: '', stderr: '' },
      driftReasonCode: null,
      coverage: [],
      parsed: null
    })
    expect(decision).toMatchObject({
      reasonCode: 'output_too_large',
      blockedReasonCode: 'agent_output_too_large'
    })
  })

  it('records a cancel without moving the task', () => {
    const decision = decidePlanReviewOutcome({
      outcome: { kind: 'cancelled', stdout: '', stderr: '' },
      driftReasonCode: null,
      coverage: [],
      parsed: null
    })
    expect(decision).toMatchObject({
      status: 'cancelled',
      reasonCode: 'cancelled_by_user',
      toState: null,
      verdict: null
    })
  })

  it('blocks on a non-zero exit', () => {
    const decision = decidePlanReviewOutcome({
      outcome: { kind: 'exit', exitCode: 3, stdout: '', stderr: '' },
      driftReasonCode: null,
      coverage: [],
      parsed: null
    })
    expect(decision).toMatchObject({ reasonCode: 'exit_nonzero', toState: 'blocked' })
  })
})

describe('decidePlanReviewOutcome — fail-closed verdict handling', () => {
  it('drift beats a clean exit AND a valid approved verdict', () => {
    const decision = decidePlanReviewOutcome({
      outcome: CLEAN_EXIT,
      driftReasonCode: 'head_moved_from_base_commit',
      coverage: [],
      parsed: APPROVED
    })
    expect(decision).toMatchObject({
      reasonCode: 'unexpected_commit_detected',
      toState: 'blocked',
      verdict: null
    })
  })

  it('a clean exit with NO parsed result is never an approval', () => {
    const decision = decidePlanReviewOutcome({
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      coverage: [],
      parsed: null
    })
    expect(decision).toMatchObject({
      reasonCode: 'verdict_unparseable',
      blockedReasonCode: 'plan_review_unparseable',
      toState: 'blocked',
      verdict: null
    })
  })

  it('a clean exit with an unparseable result is never an approval', () => {
    const decision = decidePlanReviewOutcome({
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      coverage: [],
      parsed: { ok: false, reasonCode: 'verdict_unparseable' }
    })
    expect(decision).toMatchObject({ reasonCode: 'verdict_unparseable', verdict: null })
  })
})

describe('decidePlanReviewOutcome — verdicts', () => {
  it('approved records the verdict but does NOT advance the task', () => {
    const decision = decidePlanReviewOutcome({
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      coverage: [],
      parsed: APPROVED
    })
    // Codex authorizes; only the explicit human click reaches ready_to_implement.
    expect(decision).toMatchObject({
      status: 'succeeded',
      verdict: 'approved',
      toState: null,
      blockedReasonCode: null
    })
  })

  it('fixes_requested parks the task in plan_fixes_requested', () => {
    const decision = decidePlanReviewOutcome({
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      coverage: [],
      parsed: { ok: true, verdict: 'fixes_requested', summary: 's', findingCount: 3, coverage: [] }
    })
    expect(decision).toMatchObject({
      status: 'succeeded',
      verdict: 'fixes_requested',
      toState: 'plan_fixes_requested',
      findingCount: 3
    })
  })

  it('a blocked verdict blocks the task', () => {
    const decision = decidePlanReviewOutcome({
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      coverage: [],
      parsed: { ok: true, verdict: 'blocked', summary: 's', findingCount: 1, coverage: [] }
    })
    expect(decision).toMatchObject({
      status: 'succeeded',
      verdict: 'blocked',
      toState: 'blocked',
      preBlockState: 'awaiting_plan_review'
    })
  })
})
