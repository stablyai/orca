import { createHash } from 'node:crypto'
import type { ControlPlaneDatabaseHandle } from './control-plane-store'
import { routeKey, type RouteIdentity } from './route-registry-types'

/** Blocker 8 — PreTool acceptance as a RECEIPT of the real decision.
 *
 *  The authoritative allow/block decision is not Orca's. It is made by the
 *  existing SCL PreTool policy, and duplicating that policy inside Orca would
 *  create a second security boundary that can drift from the first. So Orca does
 *  not decide; it records what the real decision was.
 *
 *  What the emitter may state is only what the decision itself owns: allow or
 *  block, which policy and version reached it, the tool, a reason, and when.
 *  Everything that binds the receipt to a Dispatch — Run, outcome, Task,
 *  Dispatch, pane, terminal, process incarnation, route and build — is filled in
 *  by the runtime from its OWN records, keyed by the attested caller. An emitter
 *  cannot name the Dispatch it applies to, so it cannot aim a receipt at one.
 *
 *  Explicitly NOT a receipt: a PostToolUse event, a static fallback stdout, the
 *  existence of a tool row or a launch token, a successful provider startup, a
 *  requested model identity, or anything a worker says. Each of those correlates
 *  with a decision without being one, and the whole package exists to stop
 *  correlation being read as proof.
 */

export type PretoolDecision = 'allow' | 'block'

export type PretoolReceiptBinding = {
  dispatchId: string
  runId: string | null
  outcomeId: string | null
  taskId: string | null
  terminalHandle: string | null
  paneKey: string | null
  processIncarnation: string | null
  requestedRoute: RouteIdentity | null
  effectiveRoute: RouteIdentity | null
  buildId: string
}

export type PretoolReceiptClaim = {
  decision: PretoolDecision
  policyId: string
  policyVersion: string
  toolName: string | null
  reason: string | null
}

export type PretoolReceiptRow = {
  receipt_id: string
  dispatch_id: string
  decision: PretoolDecision
  policy_id: string
  policy_version: string
  tool_name: string | null
  reason: string | null
  build_id: string
  observed_at: string
}

/** One receipt per (dispatch, policy, decision, tool, moment). Deterministic so a
 *  retried emit is the same receipt rather than a second vote. */
function receiptId(binding: PretoolReceiptBinding, claim: PretoolReceiptClaim, at: string): string {
  return `pr_${createHash('sha256')
    .update(
      [
        binding.dispatchId,
        binding.buildId,
        claim.policyId,
        claim.policyVersion,
        claim.decision,
        claim.toolName ?? '',
        at
      ].join(' ')
    )
    .digest('hex')
    .slice(0, 32)}`
}

export function recordPretoolReceipt(
  handle: ControlPlaneDatabaseHandle,
  args: { binding: PretoolReceiptBinding; claim: PretoolReceiptClaim; observedAt: string }
): PretoolReceiptRow {
  const { binding, claim, observedAt } = args
  const row: PretoolReceiptRow = {
    receipt_id: receiptId(binding, claim, observedAt),
    dispatch_id: binding.dispatchId,
    decision: claim.decision,
    policy_id: claim.policyId,
    policy_version: claim.policyVersion,
    tool_name: claim.toolName,
    reason: claim.reason,
    build_id: binding.buildId,
    observed_at: observedAt
  }
  handle.db
    .prepare(
      `INSERT INTO control_plane_pretool_receipts
         (receipt_id, dispatch_id, decision, policy_id, policy_version, tool_name, reason,
          build_id, run_id, outcome_id, task_id, terminal_handle, pane_key,
          process_incarnation, requested_route, effective_route, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(receipt_id) DO NOTHING`
    )
    .run(
      row.receipt_id,
      row.dispatch_id,
      row.decision,
      row.policy_id,
      row.policy_version,
      row.tool_name,
      row.reason,
      row.build_id,
      binding.runId,
      binding.outcomeId,
      binding.taskId,
      binding.terminalHandle,
      binding.paneKey,
      binding.processIncarnation,
      binding.requestedRoute ? routeKey(binding.requestedRoute) : null,
      binding.effectiveRoute ? routeKey(binding.effectiveRoute) : null,
      observedAt
    )
  return row
}

export function listPretoolReceipts(
  handle: ControlPlaneDatabaseHandle,
  dispatchId: string
): PretoolReceiptRow[] {
  return handle.db
    .prepare(
      `SELECT receipt_id, dispatch_id, decision, policy_id, policy_version, tool_name,
              reason, build_id, observed_at
       FROM control_plane_pretool_receipts WHERE dispatch_id = ? ORDER BY observed_at ASC`
    )
    .all(dispatchId) as PretoolReceiptRow[]
}

/** The PreTool verdict for this exact Dispatch on this exact build.
 *
 *  A receipt earned under a different build describes different code, so it is
 *  ignored rather than trusted — the same rule SHA-bound evidence already
 *  follows. A block outranks an allow: if the real policy refused anything on
 *  this Dispatch, the route has not been shown to be permitted.
 */
export function readPretoolVerdict(
  handle: ControlPlaneDatabaseHandle,
  args: { dispatchId: string; buildId: string }
): 'accepted' | 'denied' | null {
  const onThisBuild = listPretoolReceipts(handle, args.dispatchId).filter(
    (receipt) => receipt.build_id === args.buildId
  )
  if (onThisBuild.some((receipt) => receipt.decision === 'block')) {
    return 'denied'
  }
  return onThisBuild.some((receipt) => receipt.decision === 'allow') ? 'accepted' : null
}
