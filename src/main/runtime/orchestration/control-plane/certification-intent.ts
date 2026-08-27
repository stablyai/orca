import { createHash } from 'node:crypto'
import type { ControlPlaneDatabaseHandle } from './control-plane-store'
import { routeKey, type RouteIdentity } from './route-registry-types'

export type CertificationIntentRow = {
  intent_id: string
  run_id: string
  task_id: string
  outcome_id: string
  worktree_id: string
  agent: string
  model: string | null
  reasoning: string | null
  build_id: string
  created_at: string
  consumed_at: string | null
  consumed_dispatch_id: string | null
}

/** A first-certification launch is the one place Orca must start a worker on a
 *  route nothing has proven yet, because every certification evidence kind is
 *  produced BY a real launch, so demanding proof first is a closed loop.
 *
 *  That opening cannot be a boolean on the request. A caller-supplied flag is a
 *  caller-declared claim, and this package exists because caller-declared claims
 *  were being trusted as evidence. So the opening is a typed intent the runtime
 *  mints, stores, and then matches field-by-field against the launch it is
 *  actually about to perform:
 *
 *    - single-use: consumed atomically, so one intent authorises one Dispatch;
 *    - exactly bound: Run, Task, outcome, worktree, route and build must equal
 *      what the runtime is about to do, not what the caller says it is doing;
 *    - UNTESTED only: a route that already FAILED or went STALE has been proven,
 *      and the answer was no;
 *    - never automatic, federated or retained: the lifecycle driver mints none,
 *      a remote host owns its own execution, and a retained session has already
 *      launched so it needs no bootstrap;
 *    - certification-scoped: the Dispatch it authorises is marked, and a marked
 *      Dispatch can never advance a real outcome.
 */

export type CertificationIntentBinding = {
  runId: string
  taskId: string
  outcomeId: string
  worktreeId: string
  identity: RouteIdentity
  buildId: string
}

export type CertificationIntentRejection =
  | 'intent_unknown'
  | 'intent_consumed'
  | 'intent_run_mismatch'
  | 'intent_task_mismatch'
  | 'intent_outcome_mismatch'
  | 'intent_worktree_mismatch'
  | 'intent_route_mismatch'
  | 'intent_build_mismatch'

export type CertificationIntentVerdict =
  | { ok: true; intent: CertificationIntentRow }
  | { ok: false; code: CertificationIntentRejection; reason: string }

/** Deterministic id, so a replayed mint of the same binding is the same intent
 *  rather than a second authorisation for the same work. */
export function certificationIntentId(binding: CertificationIntentBinding): string {
  return `ci_${createHash('sha256')
    .update(
      [
        binding.runId,
        binding.taskId,
        binding.outcomeId,
        binding.worktreeId,
        routeKey(binding.identity),
        binding.buildId
      ].join(' ')
    )
    .digest('hex')
    .slice(0, 32)}`
}

export function getCertificationIntent(
  handle: ControlPlaneDatabaseHandle,
  intentId: string
): CertificationIntentRow | undefined {
  return handle.db
    .prepare('SELECT * FROM control_plane_certification_intents WHERE intent_id = ?')
    .get(intentId) as CertificationIntentRow | undefined
}

/** True when a certification intent was consumed by this Dispatch, i.e. it was
 *  admitted on a route nothing had proven. */
export function wasCertificationBootstrapDispatch(
  handle: ControlPlaneDatabaseHandle,
  dispatchId: string
): boolean {
  return (
    handle.db
      .prepare(
        'SELECT 1 FROM control_plane_certification_intents WHERE consumed_dispatch_id = ? LIMIT 1'
      )
      .get(dispatchId) !== undefined
  )
}

export function mintCertificationIntent(
  handle: ControlPlaneDatabaseHandle,
  binding: CertificationIntentBinding,
  nowIso: string
): CertificationIntentRow {
  const row: CertificationIntentRow = {
    intent_id: certificationIntentId(binding),
    run_id: binding.runId,
    task_id: binding.taskId,
    outcome_id: binding.outcomeId,
    worktree_id: binding.worktreeId,
    agent: binding.identity.agent,
    model: binding.identity.model,
    reasoning: binding.identity.reasoning,
    build_id: binding.buildId,
    created_at: nowIso,
    consumed_at: null,
    consumed_dispatch_id: null
  }
  handle.db
    .prepare(
      `INSERT INTO control_plane_certification_intents
         (intent_id, run_id, task_id, outcome_id, worktree_id, agent, model, reasoning,
          build_id, created_at, consumed_at, consumed_dispatch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id) DO NOTHING`
    )
    .run(
      row.intent_id,
      row.run_id,
      row.task_id,
      row.outcome_id,
      row.worktree_id,
      row.agent,
      row.model,
      row.reasoning,
      row.build_id,
      row.created_at,
      row.consumed_at,
      row.consumed_dispatch_id
    )
  return getCertificationIntent(handle, row.intent_id) ?? row
}

/** Verifies the intent against what the runtime is ACTUALLY about to launch.
 *  Nothing here reads the caller's description of that launch. */
export function verifyCertificationIntent(
  handle: ControlPlaneDatabaseHandle,
  args: { intentId: string; actual: CertificationIntentBinding }
): CertificationIntentVerdict {
  const intent = getCertificationIntent(handle, args.intentId)
  if (!intent) {
    return {
      ok: false,
      code: 'intent_unknown',
      reason: `No certification intent ${args.intentId}.`
    }
  }
  if (intent.consumed_at) {
    return {
      ok: false,
      code: 'intent_consumed',
      reason: `Certification intent ${args.intentId} was already used by Dispatch ${intent.consumed_dispatch_id}.`
    }
  }
  const { actual } = args
  const checks: [boolean, CertificationIntentRejection, string][] = [
    [intent.run_id !== actual.runId, 'intent_run_mismatch', `Run ${actual.runId}`],
    [intent.task_id !== actual.taskId, 'intent_task_mismatch', `Task ${actual.taskId}`],
    [
      intent.outcome_id !== actual.outcomeId,
      'intent_outcome_mismatch',
      `outcome ${actual.outcomeId}`
    ],
    [
      intent.worktree_id !== actual.worktreeId,
      'intent_worktree_mismatch',
      `worktree ${actual.worktreeId}`
    ],
    [
      // Compared as a plain key: the stored agent is whatever was minted, and
      // widening it back to TuiAgent here would assert what we are checking.
      [intent.agent, intent.model ?? '', intent.reasoning ?? ''].join('|') !==
        routeKey(actual.identity),
      'intent_route_mismatch',
      `route ${routeKey(actual.identity)}`
    ],
    [intent.build_id !== actual.buildId, 'intent_build_mismatch', `build ${actual.buildId}`]
  ]
  for (const [failed, code, what] of checks) {
    if (failed) {
      return {
        ok: false,
        code,
        reason: `Certification intent ${args.intentId} was not issued for ${what}.`
      }
    }
  }
  return { ok: true, intent }
}

/** Claims the intent BEFORE any Dispatch exists.
 *
 *  Why this order: creating the Dispatch first and consuming second leaves an
 *  orphan STARTING Dispatch behind whenever consumption loses the race. The
 *  claim is a single conditional UPDATE, so exactly one concurrent launch wins,
 *  and the loser is refused while the database still holds nothing.
 *
 *  The claim id is a placeholder; `bindCertificationIntentDispatch` replaces it
 *  with the real Dispatch id once creation succeeds, and
 *  `releaseCertificationIntent` returns the claim if creation never happens. */
export function claimCertificationIntent(
  handle: ControlPlaneDatabaseHandle,
  args: { intentId: string; claimId: string; nowIso: string }
): boolean {
  const result = handle.db
    .prepare(
      `UPDATE control_plane_certification_intents
       SET consumed_at = ?, consumed_dispatch_id = ?
       WHERE intent_id = ? AND consumed_at IS NULL`
    )
    .run(args.nowIso, args.claimId, args.intentId)
  return (result?.changes ?? 0) > 0
}

export function bindCertificationIntentToDispatch(
  handle: ControlPlaneDatabaseHandle,
  args: { intentId: string; dispatchId: string }
): void {
  handle.db
    .prepare(
      'UPDATE control_plane_certification_intents SET consumed_dispatch_id = ? WHERE intent_id = ?'
    )
    .run(args.dispatchId, args.intentId)
}

export function releaseCertificationIntentClaim(
  handle: ControlPlaneDatabaseHandle,
  args: { intentId: string; claimId: string }
): void {
  handle.db
    .prepare(
      `UPDATE control_plane_certification_intents
       SET consumed_at = NULL, consumed_dispatch_id = NULL
       WHERE intent_id = ? AND consumed_dispatch_id = ?`
    )
    .run(args.intentId, args.claimId)
}
