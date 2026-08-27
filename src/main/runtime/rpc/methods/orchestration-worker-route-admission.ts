import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import type { OrchestrationDb } from '../../orchestration/db'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { admitRoute } from '../../orchestration/control-plane/role-route-registry'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import type {
  RouteRole,
  SessionMode,
  TaskCapability
} from '../../orchestration/control-plane/route-registry-types'
import { isExcludedWorkerAgent } from '../../orchestration/control-plane/role-route-registry'
import { assertMutationAllowed } from '../../orchestration/control-plane/validation-lease'
import { validationScopeKeyForWorktree } from '../../orchestration/control-plane/validation-scope'
import { OrchestrationError } from '../../orchestration/orchestration-error'

/** B1 admission at the one place a worker session is actually created.
 *
 *  Compatibility fence: certification is enforced for a Run that has an
 *  admitted outcome. A Run without one behaves exactly as before, so historical
 *  and ad-hoc orchestration keeps working while every outcome-admitted Run gets
 *  the fail-closed contract.
 *
 *  The agent exclusion below is unconditional: local Qwen is never an Orca
 *  worker route, admitted outcome or not.
 */
export function assertWorkerStartRouteAdmitted(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  agent: TuiAgent | undefined
  model?: string
  effort?: string
  role?: RouteRole
  sessionMode?: SessionMode
  taskCapabilities?: readonly TaskCapability[]
  nowMs?: number
}): void {
  if (args.agent && isExcludedWorkerAgent(args.agent)) {
    throw new OrchestrationError(
      'route_excluded',
      `Agent ${args.agent} is excluded from Orca worker routing.`
    )
  }
  const store = new ControlPlaneStore(args.handle)
  const binding = resolveOutcomeBinding(store, args.runId)
  if (binding.kind === 'legacy_unbound') {
    return
  }
  if (!args.agent) {
    throw new OrchestrationError(
      'route_not_certified',
      'An outcome-admitted Run requires an explicit certified agent route.'
    )
  }
  const registryStore = new RouteRegistryStore(args.handle)
  const identity = {
    agent: args.agent,
    model: args.model ?? null,
    reasoning: args.effort ?? null
  }
  const admission = admitRoute({
    registry: registryStore.listRoutes(),
    evidence: registryStore.listRouteEvidence(),
    requested: identity,
    // Why identical here: worker-start has only the requested identity at this
    // point. The effective identity is proven later by the launch receipt, and
    // an identity_mismatch there is what rejects an alias masquerading as exact.
    effective: identity,
    requirement: {
      role: args.role ?? 'builder',
      sessionMode: args.sessionMode ?? 'fresh',
      taskCapabilities: args.taskCapabilities,
      // Why read the policy here: the outcome's explicit UNKNOWN-quota opt-in is
      // the operator's decision for the whole outcome. The automatic advance
      // already honours it, so a manual worker-start that ignored it would make
      // the opt-in unusable on the one path an operator actually drives.
      allowUnknownQuota: resolveAllowUnknownQuota(args.handle, binding)
    },
    nowMs: args.nowMs ?? Date.now()
  })
  if (!admission.ok) {
    throw new OrchestrationError(
      'route_not_certified',
      `${admission.error.code}: ${admission.error.reason}`,
      { routeKey: admission.error.routeKey, state: admission.error.state }
    )
  }
}

/** The outcome policy's quota opt-in, or false when the Run has no policy yet. */
function resolveAllowUnknownQuota(
  handle: ControlPlaneDatabaseHandle,
  binding: ReturnType<typeof resolveOutcomeBinding>
): boolean {
  if (binding.kind !== 'admitted') {
    return false
  }
  return new OutcomePolicyStore(handle).get(binding.outcome.outcome_id)?.allowUnknownQuota ?? false
}

/** B9 (correction 2) — the mutation fence on the one path that puts a mutating
 *  worker into a worktree.
 *
 *  A builder dispatched into a worktree whose test/preflight suite is mid-flight
 *  would edit the tree under the running gate and silently invalidate its
 *  receipt. The remedy is preserved, not removed: wait for the lease, or place
 *  the work in a separate worktree.
 */
export function assertWorktreeMutationAllowed(args: {
  handle: ControlPlaneDatabaseHandle
  worktreeId: string
  /** The Dispatch about to mutate, so a lease holder may re-enter its own scope. */
  dispatchId?: string
  nowMs?: number
}): void {
  const store = new ControlPlaneStore(args.handle)
  const scopeKey = validationScopeKeyForWorktree(args.worktreeId)
  const lease = args.dispatchId ? store.findValidationLeaseByOwner(args.dispatchId) : undefined
  const guard = assertMutationAllowed(store, {
    scopeKey,
    nowMs: args.nowMs ?? Date.now(),
    holderLeaseId: lease?.scope_key === scopeKey ? lease.lease_id : undefined
  })
  if (!guard.allowed) {
    throw new OrchestrationError('validation_in_progress', guard.reason, {
      scopeKey,
      lease: guard.lease,
      remedies: guard.remedies
    })
  }
}

/** The role and session mode a Task must be certified for.
 *
 *  A Task the lifecycle planned carries its own role: a review phase needs a
 *  certified REVIEWER on a FRESH session, and a FIX_FIRST phase needs a
 *  certified BUILDER on a RETAINED session. Anything else is an ordinary fresh
 *  builder. Reading it from the launch ledger keeps role selection out of the
 *  launch call site.
 */
export function resolveWorkerStartRole(
  handle: ControlPlaneDatabaseHandle,
  taskId: string
): {
  role: RouteRole
  sessionMode: SessionMode
  /** The route the lifecycle already selected for this Task, when it planned one. */
  plannedAgent?: TuiAgent
  plannedModel?: string
  plannedEffort?: string
} {
  const launch = new PhaseLaunchStore(handle).getByTask(taskId)
  if (!launch) {
    return { role: 'builder', sessionMode: 'fresh' }
  }
  // Why the planned route: re-engaging a retained session cannot pass --agent
  // (worker-start rejects combining it with --terminal), so the certified route
  // the plan bound is the only truthful identity to admit against.
  const planned = {
    ...(launch.agent ? { plannedAgent: launch.agent as TuiAgent } : {}),
    ...(launch.model ? { plannedModel: launch.model } : {}),
    ...(launch.reasoning ? { plannedEffort: launch.reasoning } : {})
  }
  return launch.kind === 'review'
    ? { role: 'reviewer', sessionMode: 'fresh', ...planned }
    : { role: 'builder', sessionMode: 'retained', ...planned }
}

/** One pre-flight for `orchestration.workerStart`: the route must be certified
 *  for the Task's own role, and the target worktree must not be under a live
 *  validation lease. Both run before any effect is created. */
export function assertWorkerStartAdmitted(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  taskId: string
  agent: TuiAgent | undefined
  model?: string
  effort?: string
  worktreeId?: string
}): void {
  const planned = resolveWorkerStartRole(args.handle, args.taskId)
  assertWorkerStartRouteAdmitted({
    ...args,
    role: planned.role,
    sessionMode: planned.sessionMode,
    agent: args.agent ?? planned.plannedAgent,
    model: args.model ?? planned.plannedModel,
    effort: args.effort ?? planned.plannedEffort
  })
  if (args.worktreeId) {
    assertWorktreeMutationAllowed({ handle: args.handle, worktreeId: args.worktreeId })
  }
}

/** The federated branch resolves its agent from the raw parameter, because the
 *  remote host owns the launch. */
export function assertFederatedWorkerStartAdmitted(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  agent?: string
  model?: string
  effort?: string
}): void {
  assertWorkerStartRouteAdmitted({
    ...args,
    agent: isTuiAgent(args.agent) ? args.agent : undefined
  })
}

/** The outcome id bound to a Run, for the runtime-generated worker context. */
export function resolveBoundOutcomeId(
  handle: ControlPlaneDatabaseHandle,
  runId: string
): string | undefined {
  const binding = resolveOutcomeBinding(new ControlPlaneStore(handle), runId)
  return binding.kind === 'admitted' ? binding.outcome.outcome_id : undefined
}

/** B5 (correction 3) — whether this worker-start is re-engaging a session Orca
 *  already owns in this Run, and which Dispatch it last carried.
 *
 *  Only an explicit `--terminal` reuse qualifies, and only when that terminal's
 *  most recent Dispatch belongs to the same Run and is not the one being
 *  created now. That is exactly the FIX_FIRST shape: same terminal, same
 *  session, new Dispatch for the correction Task.
 */
export function resolveRetainedReengagement(
  db: OrchestrationDb,
  args: { terminal?: string; runId: string; dispatchId: string }
): { previousTaskId: string; previousDispatchId: string } | null {
  if (!args.terminal) {
    return null
  }
  const previous = db.db
    .prepare(
      `SELECT task_id, id FROM dispatch_contexts
       WHERE assignee_handle = ? AND run_id = ? AND id <> ?
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(args.terminal, args.runId, args.dispatchId) as { task_id: string; id: string } | undefined
  return previous ? { previousTaskId: previous.task_id, previousDispatchId: previous.id } : null
}
