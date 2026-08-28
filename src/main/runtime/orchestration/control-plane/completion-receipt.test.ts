import type { RuntimeCompletionObservation } from './completion-receipt'
import { describe, expect, it } from 'vitest'
import {
  COMPLETION_PLACEMENTS,
  parseCompletionClaim,
  validateCompletionReceipt,
  type CompletionClaim,
  type CompletionExpectation
} from './completion-receipt'

const HEAD = 'a1b2c3d4e5f6'

/** What an honest runtime reading of the worktree looks like. The gate now
 *  requires one: the worker's own description of the tree is not evidence. */
function observed(
  overrides: Partial<RuntimeCompletionObservation> = {}
): RuntimeCompletionObservation {
  return {
    observable: true,
    headSha: HEAD,
    clean: true,
    changedFiles: ['src/a.ts'],
    reason: null,
    ...overrides
  }
}
const OLDER = '0f0f0f0f0f0f'

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

const expected: CompletionExpectation = {
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  runId: 'run_1',
  outcomeId: 'out_1',
  requireReceipt: true
}

describe('B6 completion receipt validation', () => {
  it('accepts a clean tree whose receipt is bound to the final HEAD', () => {
    expect(validateCompletionReceipt(claim(), expected, observed())).toEqual({
      ok: true,
      finalSha: HEAD
    })
  })

  it('rejects a PASS receipt produced against an older SHA and names the gate', () => {
    expect(
      validateCompletionReceipt(
        claim({
          receipt: { sha: OLDER, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
        }),
        expected,
        observed()
      )
    ).toMatchObject({ ok: false, code: 'stale_receipt_sha', gate: 'receipt_sha' })
  })

  it('rejects a FAIL receipt', () => {
    expect(
      validateCompletionReceipt(
        claim({
          receipt: { sha: HEAD, result: 'FAIL', policyVersion: 'v1', commandIdentity: 'pnpm test' }
        }),
        expected,
        observed()
      )
    ).toMatchObject({ ok: false, code: 'receipt_failed', gate: 'receipt_result' })
  })

  it('rejects a missing receipt when the gate is required', () => {
    expect(validateCompletionReceipt(claim({ receipt: null }), expected, observed())).toMatchObject(
      {
        ok: false,
        code: 'missing_receipt',
        gate: 'receipt'
      }
    )
  })

  it('rejects a dirty worktree the RUNTIME observed, whatever the worker claimed', () => {
    // The worker says the tree is clean; the runtime looked and it is not.
    expect(
      validateCompletionReceipt(
        claim({ worktreeClean: true }),
        expected,
        observed({ clean: false })
      )
    ).toMatchObject({
      ok: false,
      code: 'worktree_dirty',
      gate: 'runtime_observation'
    })
  })

  it('rejects a claimed commit that is not the final HEAD', () => {
    expect(
      validateCompletionReceipt(claim({ claimedSha: OLDER }), expected, observed())
    ).toMatchObject({
      ok: false,
      code: 'claimed_sha_mismatch',
      gate: 'claimed_sha'
    })
  })

  it('rejects a missing or malformed final HEAD', () => {
    expect(
      validateCompletionReceipt(claim({ headSha: '', claimedSha: '' }), expected, observed())
    ).toMatchObject({
      ok: false,
      code: 'missing_head_sha'
    })
    expect(
      validateCompletionReceipt(
        claim({ headSha: 'not-a-sha', claimedSha: 'not-a-sha' }),
        expected,
        observed()
      )
    ).toMatchObject({ ok: false, code: 'missing_head_sha' })
  })

  it('rejects the wrong Task, Dispatch, Run or outcome', () => {
    expect(
      validateCompletionReceipt(claim({ taskId: 'task_2' }), expected, observed())
    ).toMatchObject({
      ok: false,
      code: 'task_mismatch',
      gate: 'identity'
    })
    expect(
      validateCompletionReceipt(claim({ dispatchId: 'ctx_2' }), expected, observed())
    ).toMatchObject({
      ok: false,
      code: 'dispatch_mismatch'
    })
    expect(
      validateCompletionReceipt(claim({ runId: 'run_2' }), expected, observed())
    ).toMatchObject({
      ok: false,
      code: 'run_mismatch'
    })
    expect(
      validateCompletionReceipt(claim({ outcomeId: 'out_2' }), expected, observed())
    ).toMatchObject({
      ok: false,
      code: 'outcome_mismatch'
    })
  })

  it('accepts every supported execution placement and refuses an unknown one', () => {
    for (const placement of COMPLETION_PLACEMENTS) {
      expect(validateCompletionReceipt(claim({ placement }), expected, observed()).ok).toBe(true)
    }
    expect(
      validateCompletionReceipt(
        claim({ placement: 'remote-shell' as unknown as CompletionClaim['placement'] }),
        expected,
        observed()
      )
    ).toMatchObject({ ok: false, code: 'unknown_placement', gate: 'placement' })
  })

  it('skips the receipt gate only when the expectation does not require it', () => {
    expect(
      validateCompletionReceipt(
        claim({ receipt: null }),
        { ...expected, requireReceipt: false },
        observed()
      )
    ).toEqual({ ok: true, finalSha: HEAD })
  })

  it('is idempotent: replaying the identical claim produces the identical verdict', () => {
    const input = claim()
    expect(validateCompletionReceipt(input, expected, observed())).toEqual(
      validateCompletionReceipt(input, expected, observed())
    )
  })
})

describe('B6 claim parsing', () => {
  it('reports an absent completion block distinctly from a malformed one', () => {
    expect(parseCompletionClaim({})).toEqual({ present: false })
    expect(parseCompletionClaim({ completion: 'nope' })).toEqual({ present: true, claim: null })
    expect(parseCompletionClaim({ completion: { headSha: HEAD } })).toEqual({
      present: true,
      claim: null
    })
  })

  it('parses a complete block including the receipt', () => {
    const parsed = parseCompletionClaim({
      completion: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        runId: 'run_1',
        outcomeId: 'out_1',
        headSha: HEAD,
        claimedSha: HEAD,
        worktreeClean: true,
        placement: 'local',
        receipt: { sha: HEAD, result: 'PASS', policyVersion: 'v1', commandIdentity: 'pnpm test' }
      }
    })
    expect(parsed).toMatchObject({ present: true })
    expect(parsed.present && parsed.claim).toMatchObject({ headSha: HEAD, worktreeClean: true })
  })

  it('treats a missing worktreeClean flag as dirty rather than clean', () => {
    const parsed = parseCompletionClaim({
      completion: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        runId: 'run_1',
        headSha: HEAD,
        claimedSha: HEAD,
        placement: 'local'
      }
    })
    expect(parsed.present && parsed.claim?.worktreeClean).toBe(false)
  })

  it('drops a receipt whose result is not exactly PASS or FAIL', () => {
    const parsed = parseCompletionClaim({
      completion: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        runId: 'run_1',
        headSha: HEAD,
        claimedSha: HEAD,
        worktreeClean: true,
        placement: 'local',
        receipt: { sha: HEAD, result: 'probably fine' }
      }
    })
    expect(parsed.present && parsed.claim?.receipt).toBeNull()
  })
})
