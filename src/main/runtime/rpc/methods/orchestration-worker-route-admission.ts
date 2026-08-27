import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
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
  if (resolveOutcomeBinding(store, args.runId).kind === 'legacy_unbound') {
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
      taskCapabilities: args.taskCapabilities
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

/** One pre-flight for `orchestration.workerStart`: the route must be certified
 *  for an outcome-admitted Run, and the target worktree must not be under a
 *  live validation lease. Both run before any effect is created. */
export function assertWorkerStartAdmitted(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  agent: TuiAgent | undefined
  model?: string
  effort?: string
  worktreeId?: string
}): void {
  assertWorkerStartRouteAdmitted(args)
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
