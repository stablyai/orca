import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import type { OrchestrationDb } from '../../orchestration/db'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { assertOutcomeSerializationAllowed } from '../../orchestration/control-plane/outcome-serialization'
import { classifyNativeRoute } from '../../../../shared/native-route-contract'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { admitRoute } from '../../orchestration/control-plane/role-route-registry'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import { resolveRuntimeBuildIdentity } from '../../orchestration/control-plane/runtime-build-identity'
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
  /** Injectable only so tests can pin a build; production resolves its own. */
  runtimeBuildIdentity?: { id: string; commitSha?: string | null }
}): void {
  if (args.agent && isExcludedWorkerAgent(args.agent)) {
    throw new OrchestrationError(
      'route_excluded',
      `Agent ${args.agent} is excluded from Orca worker routing.`
    )
  }
  // Why the shared contract: admission previously re-derived what a route can
  // do from the registry alone. Reading the ONE derived contract here is what
  // makes it the single route contract rather than another opinion.
  if (args.agent) {
    const native = classifyNativeRoute({
      agent: args.agent,
      model: args.model ?? null,
      reasoning: args.effort ?? null
    })
    if (native.verdict === 'TRULY_UNSUPPORTED') {
      throw new OrchestrationError('route_unsupported', `${native.verdict}: ${native.reason}`, {
        verdict: native.verdict,
        agent: args.agent,
        model: args.model ?? null,
        launchStrategies: native.capability.launchStrategies,
        nativeLaunchPossible: native.capability.nativeLaunchPossible
      })
    }
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
  const evidence = registryStore.listRouteEvidence()
  const build = args.runtimeBuildIdentity ?? resolveRuntimeBuildIdentity()
  const admission = admitRoute({
    registry: registryStore.listRoutes(),
    evidence,
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
    nowMs: args.nowMs ?? Date.now(),
    // Why the runtime's own commit and not one derived from the evidence:
    // deriving the "current" SHA from the evidence being checked lets that
    // evidence authorise itself. The runtime states what it is running.
    currentCommitSha: build.commitSha ?? undefined,
    currentRuntimeVersion: build.id
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
  const nowMs = args.nowMs ?? Date.now()
  const lease = args.dispatchId
    ? store.findValidationLeaseByOwner(args.dispatchId, new Date(nowMs).toISOString())
    : undefined
  const guard = assertMutationAllowed(store, {
    scopeKey,
    nowMs,
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
  /** Set when the start re-engages an existing worker session instead of
   *  creating one. Its worktree is fenced the same way a new one is. */
  terminalHandle?: string
}): void {
  // Why before the route check: an outcome an operator serialized against a
  // live one must not start work at all, whatever route it would have used.
  assertOutcomeNotSerialized(args.handle, args.runId)
  const planned = resolveWorkerStartRole(args.handle, args.taskId)
  assertWorkerStartRouteAdmitted({
    ...args,
    role: planned.role,
    sessionMode: planned.sessionMode,
    agent: args.agent ?? planned.plannedAgent,
    model: args.model ?? planned.plannedModel,
    effort: args.effort ?? planned.plannedEffort
  })
  // Why resolve the retained tree: a re-engagement names a TERMINAL, not a
  // worktree, so fencing only on an explicit worktree let an already-running
  // builder be driven back into a tree that is under validation.
  const worktreeId = args.worktreeId ?? resolveTerminalWorktreeId(args.handle, args.terminalHandle)
  if (worktreeId) {
    assertWorktreeMutationAllowed({ handle: args.handle, worktreeId })
  }
}

/** The worktree an existing worker terminal is bound to, from the runtime's own
 *  worker record. Null when the terminal is not a known worker session. */
function resolveTerminalWorktreeId(
  handle: ControlPlaneDatabaseHandle,
  terminalHandle: string | undefined
): string | undefined {
  if (!terminalHandle) {
    return undefined
  }
  const row = handle.db
    .prepare(
      `SELECT w.worktree_id AS worktreeId
       FROM worker_dispatches w
       JOIN dispatch_contexts d ON d.id = w.dispatch_id
       WHERE d.assignee_handle = ? AND w.worktree_id IS NOT NULL
       ORDER BY w.rowid DESC LIMIT 1`
    )
    .get(terminalHandle) as { worktreeId: string } | undefined
  return row?.worktreeId
}

/** Serialization is a property of the OUTCOME, not of where work executes, so
 *  it is asserted identically on the local and federated branches. */
function assertOutcomeNotSerialized(handle: ControlPlaneDatabaseHandle, runId: string): void {
  const serialization = assertOutcomeSerializationAllowed({
    db: handle as unknown as OrchestrationDb,
    store: new ControlPlaneStore(handle),
    runId
  })
  if (!serialization.allowed) {
    throw new OrchestrationError('serialized_with_active_outcome', serialization.reason, {
      blockingOutcomeId: serialization.blockingOutcomeId,
      blockingRunId: serialization.blockingRunId,
      blockingDispatchId: serialization.blockingDispatchId
    })
  }
}

/** The federated branch resolves its agent from the raw parameter, because the
 *  remote host owns the launch.
 *
 *  Why the same two guards as the local branch: `--on <host>` used to check the
 *  route only, so a serialized outcome or a worktree under a live validation
 *  lease was fenced locally and wide open federated. Where the work executes
 *  does not change whether it is allowed to start. */
export function assertFederatedWorkerStartAdmitted(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  agent?: string
  model?: string
  effort?: string
  /** Set when the federated start re-engages an existing worker session. */
  terminalHandle?: string
}): void {
  assertOutcomeNotSerialized(args.handle, args.runId)
  assertWorkerStartRouteAdmitted({
    ...args,
    agent: isTuiAgent(args.agent) ? args.agent : undefined
  })
  const worktreeId = resolveTerminalWorktreeId(args.handle, args.terminalHandle)
  if (worktreeId) {
    assertWorktreeMutationAllowed({ handle: args.handle, worktreeId })
  }
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
