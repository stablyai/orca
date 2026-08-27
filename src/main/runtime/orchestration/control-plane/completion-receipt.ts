/** B6 — software, not prose, decides whether a `worker_done` is acceptable.
 *
 *  State machine:
 *    trigger                  immediate state  writer                next state
 *    -------------------------------------------------------------------------
 *    worker_done arrives      validating       validateCompletion    accepted | rejected
 *    accepted                 settled          settleWorkerReport    terminal
 *    rejected                 unchanged        convertToRejection    worker may retry
 *  Idempotency: validation is a pure function of the claim, so a replayed
 *  identical `worker_done` produces the identical verdict and the existing
 *  settle-path duplicate handling makes the second one a no-op.
 *  Retry: a rejection names the exact failed gate, so the worker can fix that
 *  one gate and resend without the coordinator re-deriving anything.
 *  Failure recovery: an unparseable or absent receipt is `missing_receipt`,
 *  never an accepted completion.
 */

export type CompletionPlacement = 'local' | 'folder' | 'ssh'

export const COMPLETION_PLACEMENTS: readonly CompletionPlacement[] = ['local', 'folder', 'ssh']

export type CompletionGateReceipt = {
  /** The SHA the test/preflight receipt was produced against. */
  sha: string
  result: 'PASS' | 'FAIL'
  policyVersion: string
  commandIdentity: string
}

export type CompletionClaim = {
  taskId: string
  dispatchId: string
  runId: string
  outcomeId: string | null
  /** Exact final Git HEAD of the worktree at completion time. */
  headSha: string
  /** The commit the worker claims it delivered. */
  claimedSha: string
  worktreeClean: boolean
  placement: CompletionPlacement
  receipt: CompletionGateReceipt | null
}

export type CompletionExpectation = {
  taskId: string
  dispatchId: string
  runId: string
  outcomeId: string | null
  requireReceipt: boolean
}

export type CompletionGate =
  | 'identity'
  | 'head_sha'
  | 'claimed_sha'
  | 'receipt'
  | 'receipt_sha'
  | 'receipt_result'
  | 'worktree_clean'
  | 'placement'

export type CompletionRejectionCode =
  | 'task_mismatch'
  | 'dispatch_mismatch'
  | 'run_mismatch'
  | 'outcome_mismatch'
  | 'missing_head_sha'
  | 'claimed_sha_mismatch'
  | 'missing_receipt'
  | 'stale_receipt_sha'
  | 'receipt_failed'
  | 'worktree_dirty'
  | 'unknown_placement'

export type CompletionRejection = {
  ok: false
  code: CompletionRejectionCode
  gate: CompletionGate
  reason: string
}

export type CompletionValidation = { ok: true; finalSha: string } | CompletionRejection

const SHA_PATTERN = /^[0-9a-f]{7,64}$/

export function validateCompletionReceipt(
  claim: CompletionClaim,
  expected: CompletionExpectation
): CompletionValidation {
  const reject = (
    code: CompletionRejectionCode,
    gate: CompletionGate,
    reason: string
  ): CompletionRejection => ({ ok: false, code, gate, reason })

  if (claim.taskId !== expected.taskId) {
    return reject(
      'task_mismatch',
      'identity',
      `Completion claims task ${claim.taskId}; this Dispatch owns ${expected.taskId}.`
    )
  }
  if (claim.dispatchId !== expected.dispatchId) {
    return reject(
      'dispatch_mismatch',
      'identity',
      `Completion claims dispatch ${claim.dispatchId}; expected ${expected.dispatchId}.`
    )
  }
  if (claim.runId !== expected.runId) {
    return reject(
      'run_mismatch',
      'identity',
      `Completion claims Run ${claim.runId}; expected ${expected.runId}.`
    )
  }
  if ((claim.outcomeId ?? null) !== (expected.outcomeId ?? null)) {
    return reject(
      'outcome_mismatch',
      'identity',
      `Completion claims outcome ${claim.outcomeId ?? '<none>'}; expected ${expected.outcomeId ?? '<none>'}.`
    )
  }
  if (!COMPLETION_PLACEMENTS.includes(claim.placement)) {
    // Why an enum rather than a command string: the receipt must describe where
    // the work ran without the runtime ever executing untrusted shell text.
    return reject(
      'unknown_placement',
      'placement',
      `Unknown execution placement ${String(claim.placement)}.`
    )
  }
  if (!SHA_PATTERN.test(claim.headSha)) {
    return reject('missing_head_sha', 'head_sha', 'Completion is missing a valid final Git HEAD.')
  }
  if (claim.claimedSha !== claim.headSha) {
    return reject(
      'claimed_sha_mismatch',
      'claimed_sha',
      `Claimed commit ${claim.claimedSha} is not the final HEAD ${claim.headSha}.`
    )
  }
  if (!claim.worktreeClean) {
    return reject(
      'worktree_dirty',
      'worktree_clean',
      'Worktree is dirty at completion; the delivered SHA does not describe the tree.'
    )
  }
  if (!expected.requireReceipt) {
    return { ok: true, finalSha: claim.headSha }
  }
  if (!claim.receipt) {
    return reject('missing_receipt', 'receipt', 'Completion carries no test/preflight receipt.')
  }
  if (claim.receipt.sha !== claim.headSha) {
    // Why this is the sharp edge: a PASS produced before the last commit proves
    // nothing about what is being delivered.
    return reject(
      'stale_receipt_sha',
      'receipt_sha',
      `Receipt was produced against ${claim.receipt.sha}, not the final HEAD ${claim.headSha}.`
    )
  }
  if (claim.receipt.result !== 'PASS') {
    return reject('receipt_failed', 'receipt_result', 'Test/preflight receipt is FAIL.')
  }
  return { ok: true, finalSha: claim.headSha }
}

/** Parses the `completion` block a worker attaches to its `worker_done`
 *  payload. Returns null when absent so the caller can decide whether the gate
 *  applies to this Run at all. */
export function parseCompletionClaim(
  payload: Record<string, unknown>
): { present: false } | { present: true; claim: CompletionClaim | null } {
  const raw = payload.completion
  if (raw === undefined || raw === null) {
    return { present: false }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { present: true, claim: null }
  }
  const record = raw as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof record[key] === 'string' && (record[key] as string).length > 0
      ? (record[key] as string)
      : null
  const headSha = str('headSha')
  const claimedSha = str('claimedSha')
  const placement = str('placement')
  const taskId = str('taskId')
  const dispatchId = str('dispatchId')
  // Why runId is optional: the runtime already knows which Run owns the
  // Dispatch. A stated runId is still checked, but a worker is never required
  // to restate it, so an omitted one is not a malformed claim.
  const runId = str('runId') ?? ''
  if (!headSha || !claimedSha || !placement || !taskId || !dispatchId) {
    return { present: true, claim: null }
  }
  const receiptRaw = record.receipt
  let receipt: CompletionGateReceipt | null = null
  if (receiptRaw && typeof receiptRaw === 'object' && !Array.isArray(receiptRaw)) {
    const receiptRecord = receiptRaw as Record<string, unknown>
    const sha = typeof receiptRecord.sha === 'string' ? receiptRecord.sha : null
    const result =
      receiptRecord.result === 'PASS' || receiptRecord.result === 'FAIL'
        ? receiptRecord.result
        : null
    if (sha && result) {
      receipt = {
        sha,
        result,
        policyVersion:
          typeof receiptRecord.policyVersion === 'string'
            ? receiptRecord.policyVersion
            : 'unversioned',
        commandIdentity:
          typeof receiptRecord.commandIdentity === 'string'
            ? receiptRecord.commandIdentity
            : 'unspecified'
      }
    }
  }
  return {
    present: true,
    claim: {
      taskId,
      dispatchId,
      runId,
      outcomeId: str('outcomeId'),
      headSha,
      claimedSha,
      worktreeClean: record.worktreeClean === true,
      placement: placement as CompletionPlacement,
      receipt
    }
  }
}
