import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { admitRoute } from '../../orchestration/control-plane/role-route-registry'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import type {
  RouteRole,
  SessionMode,
  TaskCapability
} from '../../orchestration/control-plane/route-registry-types'
import { isExcludedWorkerAgent } from '../../orchestration/control-plane/role-route-registry'
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
