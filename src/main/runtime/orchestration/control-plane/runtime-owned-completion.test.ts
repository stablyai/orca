import { describe, expect, it } from 'vitest'
import {
  validateCompletionReceipt,
  type CompletionClaim,
  type CompletionExpectation,
  type RuntimeCompletionObservation
} from './completion-receipt'

/** RUNTIME_OWNED_COMPLETION_PROOF — the blocked head compared the worker's
 *  `claimedSha` against the worker's `headSha` and read the worker's
 *  `worktreeClean`. Every one of those arrives in the same payload, so the gate
 *  proved only that the worker was internally consistent with itself. A worker
 *  that sent two equal SHAs, `worktreeClean: true` and `result: 'PASS'` walked
 *  straight through a gate that had observed nothing.
 */
describe('RUNTIME_OWNED_COMPLETION_PROOF', () => {
  const HEAD = 'a1b2c3d4e5f6'
  const OTHER = 'f6e5d4c3b2a1'

  const expected: CompletionExpectation = {
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    runId: 'run_1',
    outcomeId: 'out_1',
    requireReceipt: true
  }

  function claim(overrides: Partial<CompletionClaim> = {}): CompletionClaim {
    return {
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      runId: 'run_1',
      outcomeId: 'out_1',
      headSha: HEAD,
      claimedSha: HEAD,
      worktreeClean: true,
      placement: 'local',
      receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' },
      ...overrides
    }
  }

  function observed(
    overrides: Partial<RuntimeCompletionObservation> = {}
  ): RuntimeCompletionObservation {
    return {
      observable: true,
      headSha: HEAD,
      clean: true,
      changedFiles: [],
      reason: null,
      ...overrides
    }
  }

  it('rejects a fabricated worker PASS the runtime never saw', () => {
    // The perfectly self-consistent payload the old gate accepted.
    const fabricated = claim()
    // The runtime looked at the tree and it is on a different commit entirely.
    expect(
      validateCompletionReceipt(fabricated, expected, observed({ headSha: OTHER }))
    ).toMatchObject({ ok: false, code: 'sha_not_observed', gate: 'runtime_observation' })
  })

  it('rejects equal claimed SHAs when the runtime observed something else', () => {
    expect(
      validateCompletionReceipt(
        claim({ headSha: HEAD, claimedSha: HEAD }),
        expected,
        observed({ headSha: OTHER })
      )
    ).toMatchObject({ ok: false, code: 'sha_not_observed' })
  })

  it('rejects a claimed clean tree the runtime observed as dirty', () => {
    expect(
      validateCompletionReceipt(
        claim({ worktreeClean: true }),
        expected,
        observed({ clean: false })
      )
    ).toMatchObject({ ok: false, code: 'worktree_dirty', gate: 'runtime_observation' })
  })

  it('fails closed when no runtime observation is supplied at all', () => {
    expect(validateCompletionReceipt(claim(), expected)).toMatchObject({
      ok: false,
      code: 'evidence_unobservable',
      gate: 'runtime_observation'
    })
  })

  it('fails closed when the runtime could not read the worktree', () => {
    expect(
      validateCompletionReceipt(
        claim(),
        expected,
        observed({ observable: false, headSha: null, clean: null, reason: 'worktree is gone' })
      )
    ).toMatchObject({ ok: false, code: 'evidence_unobservable' })
  })

  it('accepts only when the runtime independently corroborates the claim', () => {
    expect(validateCompletionReceipt(claim(), expected, observed())).toEqual({
      ok: true,
      finalSha: HEAD
    })
  })

  it('refuses a PASS receipt with no runtime-owned gate execution behind it', () => {
    expect(validateCompletionReceipt(claim(), expected, observed(), false)).toMatchObject({
      ok: false,
      code: 'gate_not_executed',
      gate: 'receipt_result'
    })
  })

  it('accepts the same PASS once the runtime itself ran the gate', () => {
    expect(validateCompletionReceipt(claim(), expected, observed(), true)).toEqual({
      ok: true,
      finalSha: HEAD
    })
  })
})
