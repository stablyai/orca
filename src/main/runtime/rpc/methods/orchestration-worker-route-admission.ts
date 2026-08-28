import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { assertCertificationIntentMatches } from './orchestration-certification-launch'
import {
  readOutcomeTarget,
  resolveOutcomeBinding
} from '../../orchestration/control-plane/outcome-identity'
import { classifyNativeRoute } from '../../../../shared/native-route-contract'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
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
import {
  isCertifiableRuntimeBuildIdentity,
  type RuntimeBuildIdentity
} from '../../orchestration/control-plane/runtime-build-identity'

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
  /** The receiving runtime's pinned build identity. Required, and never
   *  resolved here: a module that resolves its own is a second authority that
   *  can disagree with the one the process was constructed with. */
  runtimeBuildIdentity: RuntimeBuildIdentity
  /** Runtime-proven placement in a worktree distinct from the coordinator and
   * other writers. Required when the provider hook is status-only rather than
   * a synchronous mutation fence. */
  isolatedWorktree?: boolean
  /** A typed, single-use certification intent the runtime minted and will match
   *  field-by-field against this launch. Never a caller-declared boolean. */
  certificationIntent?: string
  /** What the runtime is ACTUALLY about to launch, for the intent to be matched
   *  against. Absent when the caller supplied no intent. */
  intentActual?: {
    taskId: string
    worktreeId: string | null
    retryOfDispatchId?: string | null
  }
}): { bootstrapUsed: boolean } {
  if (args.agent && isExcludedWorkerAgent(args.agent)) {
    throw new OrchestrationError(
      'route_excluded',
      `Agent ${args.agent} is excluded from Orca worker routing.`
    )
  }
  // Why the shared contract: admission previously re-derived what a route can
  // do from the registry alone. Reading the ONE derived contract here is what
  // makes it the single route contract rather than another opinion.
  const native = args.agent
    ? classifyNativeRoute({
        agent: args.agent,
        model: args.model ?? null,
        reasoning: args.effort ?? null
      })
    : null
  if (native) {
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
    return { bootstrapUsed: false }
  }
  if (!isCertifiableRuntimeBuildIdentity(args.runtimeBuildIdentity)) {
    throw new OrchestrationError(
      'runtime_build_unverifiable',
      'Outcome-admitted work requires a clean embedded source SHA and verified complete artifact manifest.'
    )
  }
  if (!args.agent) {
    throw new OrchestrationError(
      'route_not_certified',
      'An outcome-admitted Run requires an explicit certified agent route.'
    )
  }
  if (native?.capability.pretoolEnforcement !== 'blocking' && !args.isolatedWorktree) {
    throw new OrchestrationError(
      'route_mutation_fence_unavailable',
      `${args.agent} has ${native?.capability.pretoolEnforcement ?? 'unsupported'} pre-tool enforcement on this platform. Outcome-admitted work requires either a blocking hook or a runtime-proven isolated worktree.`,
      {
        agent: args.agent,
        pretoolEnforcement: native?.capability.pretoolEnforcement ?? 'unsupported',
        remedies: ['use_isolated_worktree', 'choose_blocking_route']
      }
    )
  }
  const registryStore = new RouteRegistryStore(args.handle)
  const identity = {
    agent: args.agent,
    model: args.model ?? null,
    reasoning: args.effort ?? null
  }
  const evidence = registryStore.listRouteEvidence()
  const build = args.runtimeBuildIdentity
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
    currentRuntimeVersion: build.id,
    // Why verified BEFORE it is allowed to weigh on admission: the intent has to
    // describe this exact launch, and only the runtime can say what this launch
    // is. A caller that merely asserts "this is a certification run" gets nothing.
    bootstrapUncertified: assertCertificationIntentMatches({
      handle: args.handle,
      intentId: args.certificationIntent,
      runId: args.runId,
      outcomeId: binding.kind === 'admitted' ? binding.outcome.outcome_id : '',
      taskId: args.intentActual?.taskId ?? '',
      worktreeId: args.intentActual?.worktreeId ?? '',
      retryOfDispatchId: args.intentActual?.retryOfDispatchId ?? null,
      identity,
      buildId: build.id
    })
  })
  if (!admission.ok) {
    throw new OrchestrationError(
      'route_not_certified',
      `${admission.error.code}: ${admission.error.reason}`,
      { routeKey: admission.error.routeKey, state: admission.error.state }
    )
  }
  // Why report this back: an intent supplied for a route that turned out to be
  // certified already was never USED, and consuming it would mark ordinary
  // delivered work as a bootstrap Dispatch — which can never advance. Only the
  // launch the exception actually authorised may be marked.
  return { bootstrapUsed: admission.bootstrap === true }
}

/** The outcome policy's quota opt-in, or false when the Run has no policy yet. */

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
  // No holder exemption: re-engaging the very Dispatch that took the lease is
  // re-engaging the one whose gate is reading this tree right now.
  const guard = assertMutationAllowed(store, { scopeKey, nowMs })
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
  runtimeBuildIdentity: RuntimeBuildIdentity
  runId: string
  taskId: string
  agent: TuiAgent | undefined
  model?: string
  effort?: string
  worktreeId?: string
  /** Forwarded from the explicit request; the phase-launch driver sets none. */
  certificationIntent?: string
  /** The Dispatch this start retries, so a retry grant is matched as a retry. */
  retryOf?: string
  /** Set when the start re-engages an existing worker session instead of
   *  creating one. Its worktree is fenced the same way a new one is. */
  terminalHandle?: string
  isolatedWorktree?: boolean
}): { bootstrapUsed: boolean } {
  const worktreeId = args.worktreeId ?? resolveTerminalWorktreeId(args.handle, args.terminalHandle)
  assertOutcomeTargetMatches(args.handle, args.runId, worktreeId)
  // Why before the route check: an outcome an operator serialized against a
  // live one must not start work at all, whatever route it would have used.
  assertOutcomeNotSerialized(args.handle, args.runId)
  const planned = resolveWorkerStartRole(args.handle, args.taskId)
  // A retained re-engagement has already launched, so it needs no bootstrap and
  // must never be able to buy one.
  if (args.certificationIntent && args.terminalHandle) {
    throw new OrchestrationError(
      'certification_intent_invalid',
      'A certification intent cannot authorise a retained re-engagement; that session already launched.'
    )
  }
  const admitted = assertWorkerStartRouteAdmitted({
    ...args,
    role: planned.role,
    sessionMode: planned.sessionMode,
    agent: args.agent ?? planned.plannedAgent,
    model: args.model ?? planned.plannedModel,
    effort: args.effort ?? planned.plannedEffort,
    intentActual: {
      taskId: args.taskId,
      worktreeId: args.worktreeId ?? null,
      retryOfDispatchId: args.retryOf ?? null
    },
    isolatedWorktree: args.isolatedWorktree
  })
  // Why resolve the retained tree: a re-engagement names a TERMINAL, not a
  // worktree, so fencing only on an explicit worktree let an already-running
  // builder be driven back into a tree that is under validation.
  if (worktreeId) {
    assertWorktreeMutationAllowed({ handle: args.handle, worktreeId })
  }
  return admitted
}

/** The worktree an existing worker terminal is bound to, from the runtime's own
 *  worker record. Null when the terminal is not a known worker session. */

/** Serialization is a property of the OUTCOME, not of where work executes, so
 *  it is asserted identically on the local and federated branches. */

/** The federated branch resolves its agent from the raw parameter, because the
 *  remote host owns the launch.
 *
 *  Why the same two guards as the local branch: `--on <host>` used to check the
 *  route only, so a serialized outcome or a worktree under a live validation
 *  lease was fenced locally and wide open federated. Where the work executes
 *  does not change whether it is allowed to start. */

export function assertFederatedWorkerStartAdmitted(args: {
  handle: ControlPlaneDatabaseHandle
  runtimeBuildIdentity: RuntimeBuildIdentity
  runId: string
  agent?: string
  model?: string
  effort?: string
  /** Set when the federated start re-engages an existing worker session. */
  terminalHandle?: string
  worktreeSelector?: string
  certificationIntent?: string
}): void {
  // The execution host owns everything that touches execution, so this client
  // cannot witness a remote launch and must not authorise one as evidence.
  if (args.certificationIntent) {
    throw new OrchestrationError(
      'certification_intent_invalid',
      'A certification intent is only valid for a local launch this runtime can observe.'
    )
  }
  const federatedBinding = resolveOutcomeBinding(new ControlPlaneStore(args.handle), args.runId)
  if (federatedBinding.kind === 'admitted' && federatedBinding.outcome.intake_batch) {
    // Intake currently freezes a LOCAL RuntimeTargetContext. A remote runtime
    // may reuse the same worktree id for a different repository/path, so raw
    // selector equality is not target proof. Refuse rather than silently let a
    // custom/federated start bypass the batch boundary; a future remote target
    // attestation can make this path eligible without weakening local intake.
    throw new OrchestrationError(
      'outcome_target_remote_unverifiable',
      `Batch-admitted outcome ${federatedBinding.outcome.outcome_id} cannot start federated until the remote runtime attests the complete immutable target context.`
    )
  }
  assertOutcomeNotSerialized(args.handle, args.runId)
  const retainedWorktree = resolveTerminalWorktreeId(args.handle, args.terminalHandle)
  const selectedWorktree = retainedWorktree ?? args.worktreeSelector
  assertOutcomeTargetMatches(args.handle, args.runId, selectedWorktree)
  assertWorkerStartRouteAdmitted({
    ...args,
    agent: isTuiAgent(args.agent) ? args.agent : undefined
  })
  const worktreeId = resolveTerminalWorktreeId(args.handle, args.terminalHandle)
  if (worktreeId) {
    assertWorktreeMutationAllowed({ handle: args.handle, worktreeId })
  }
}

export function assertOutcomeTargetMatches(
  handle: ControlPlaneDatabaseHandle,
  runId: string,
  actualWorktreeId: string | undefined
): void {
  const store = new ControlPlaneStore(handle)
  const binding = resolveOutcomeBinding(store, runId)
  if (binding.kind !== 'admitted' || !binding.outcome.intake_batch) {
    return
  }
  const target = readOutcomeTarget(store, binding.outcome.outcome_id)
  const normalizedTarget = target?.startsWith('id:') ? target.slice(3) : target
  const normalizedActual = actualWorktreeId?.startsWith('id:')
    ? actualWorktreeId.slice(3)
    : actualWorktreeId
  if (!normalizedTarget || !normalizedActual || normalizedTarget !== normalizedActual) {
    throw new OrchestrationError(
      'outcome_target_mismatch',
      `Outcome ${binding.outcome.outcome_id} is bound to ${normalizedTarget ?? '<unreadable>'}, not ${normalizedActual ?? '<unresolved>'}.`,
      { target: normalizedTarget, actual: normalizedActual }
    )
  }
}

/** The outcome id bound to a Run, for the runtime-generated worker context. */

export * from './orchestration-worker-route-resolution'
import {
  assertOutcomeNotSerialized,
  resolveAllowUnknownQuota,
  resolveTerminalWorktreeId
} from './orchestration-worker-route-guards'
