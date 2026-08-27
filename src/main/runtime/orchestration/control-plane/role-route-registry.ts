import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  resolveRouteCertification,
  type CertificationState,
  type CertificationVerdict,
  type RouteEvidence
} from './route-certification-evidence'
import {
  routeKey,
  sameRouteIdentity,
  UNKNOWN,
  type RouteIdentity,
  type RouteRole,
  type RouteRow,
  type SessionMode,
  type TaskCapability
} from './route-registry-types'

/** B1 + CORRECTION 1 — the one authoritative admission contract.
 *
 *  Model-agnostic by construction:
 *   - no provider or model name appears in a branch that selects a route;
 *   - eligibility is a pure predicate over declared fields, so permuting the
 *     registry cannot change which routes are eligible;
 *   - automatic fallback walks a candidate order the CALLER supplies (DCS/Sol),
 *     never an order Orca invents. With no candidate order there is no
 *     automatic choice at all.
 *
 *  The only two model-name rules are hard exclusions, not rankings, and both
 *  are stated as policy the registry can override with evidence where the
 *  correction allows it.
 */

/** Local Qwen is routed by the Reality broker, never by Orca worker routing. */
const EXCLUDED_WORKER_AGENTS: readonly TuiAgent[] = ['qwen-code']

/** Reviewer-oriented model tokens. A route bearing one of these may still take
 *  a builder role, but only when its own certification evidence proves it —
 *  never by default and never by a ranking. */
const REVIEWER_ORIENTED_MODEL_TOKENS = ['fable'] as const

export type RouteRegistry = readonly RouteRow[]

export function isExcludedWorkerAgent(agent: TuiAgent): boolean {
  return EXCLUDED_WORKER_AGENTS.includes(agent)
}

export function isReviewerOrientedModel(model: string | null): boolean {
  if (!model) {
    return false
  }
  const normalized = model.toLowerCase()
  return REVIEWER_ORIENTED_MODEL_TOKENS.some(
    (token) =>
      normalized === token ||
      normalized.startsWith(`${token}-`) ||
      normalized.endsWith(`-${token}`) ||
      normalized.includes(`-${token}-`)
  )
}

export function findRoute(registry: RouteRegistry, identity: RouteIdentity): RouteRow | undefined {
  const key = routeKey(identity)
  return registry.find((row) => routeKey(row.identity) === key)
}

export type RouteRequirement = {
  role: RouteRole
  sessionMode: SessionMode
  /** Every capability must be declared by the route; an empty list matches all. */
  taskCapabilities?: readonly TaskCapability[]
  reasoning?: string | null
  /** When true, a route whose quota state is UNKNOWN may still be scheduled.
   *  Off by default so an unobserved quota is never fabricated as available. */
  allowUnknownQuota?: boolean
}

export type RouteAdmissionCode =
  | 'identity_mismatch'
  | 'route_unknown'
  | 'route_untested'
  | 'route_stale'
  | 'route_failed'
  | 'route_unsupported'
  | 'role_not_eligible'
  | 'capability_not_eligible'
  | 'session_mode_unsupported'
  | 'reasoning_unsupported'
  | 'agent_excluded'
  | 'identity_proof_insufficient'
  | 'launcher_hook_drift'
  | 'provider_unavailable'
  | 'quota_unknown'
  | 'quota_exhausted'

export type RouteAdmissionError = {
  code: RouteAdmissionCode
  routeKey: string
  role: RouteRole
  sessionMode: SessionMode
  state: CertificationState
  reason: string
}

export type RouteAdmission =
  | { ok: true; route: RouteRow; verdict: CertificationVerdict; bootstrap?: true }
  | { ok: false; error: RouteAdmissionError }

export type EligibilityFailure = { code: RouteAdmissionCode; reason: string }

/** Pure, order-independent eligibility. Declared facts only — no certification,
 *  no clock, no registry position. */
export function checkRouteEligibility(
  route: RouteRow,
  requirement: RouteRequirement,
  /** Set only under a verified certification intent. See `admitRoute`. */
  bootstrapUncertified = false
): EligibilityFailure | null {
  const key = routeKey(route.identity)
  if (isExcludedWorkerAgent(route.identity.agent)) {
    return {
      code: 'agent_excluded',
      reason: `Agent ${route.identity.agent} is excluded from Orca worker routing.`
    }
  }
  if (!route.launcherSupported) {
    return { code: 'route_unsupported', reason: `Route ${key} has no supported Orca launcher.` }
  }
  // Why a hard fault and not a soft skip: a route the launcher accepts but the
  // hook layer rejects fails halfway through real work instead of at admission.
  if (route.launcherSupported && !route.hookSupported) {
    return {
      code: 'launcher_hook_drift',
      reason: `Route ${key} is launcher-supported but not a managed agent-hook target.`
    }
  }
  // Why a bootstrap may pass: a family alias resolves to whatever the host CLI
  // has installed today, so the EFFECTIVE identity can only be learned by
  // launching and observing it. Refusing the launch outright is the same closed
  // loop as demanding certification before any launch — the route could never
  // become exact. Certification still requires `effective_model_identity`
  // evidence, so an unresolved alias can be launched but never certified.
  if (route.identityProof !== 'exact' && !bootstrapUncertified) {
    return {
      code: 'identity_proof_insufficient',
      reason: `Route ${key} identity proof is ${route.identityProof}; an alias is not exact identity.`
    }
  }
  if (!route.roles.includes(requirement.role)) {
    return {
      code: 'role_not_eligible',
      reason: `Route ${key} is not eligible for ${requirement.role}.`
    }
  }
  if (!route.sessionModes.includes(requirement.sessionMode)) {
    return {
      code: 'session_mode_unsupported',
      reason: `Route ${key} does not support ${requirement.sessionMode} sessions.`
    }
  }
  const missing = (requirement.taskCapabilities ?? []).filter(
    (capability) => !route.taskCapabilities.includes(capability)
  )
  if (missing.length > 0) {
    return {
      code: 'capability_not_eligible',
      reason: `Route ${key} lacks task capabilities: ${missing.join(', ')}.`
    }
  }
  const reasoning = requirement.reasoning ?? route.identity.reasoning
  if (reasoning && !route.reasoningModes.includes(reasoning)) {
    return {
      code: 'reasoning_unsupported',
      reason: `Route ${key} does not support reasoning ${reasoning}.`
    }
  }
  if (route.readiness.availability === 'unavailable') {
    return {
      code: 'provider_unavailable',
      reason: `Route ${key} reports the provider unavailable.`
    }
  }
  if (route.readiness.quota.state === 'exhausted') {
    return { code: 'quota_exhausted', reason: `Route ${key} reports its quota exhausted.` }
  }
  if (route.readiness.quota.state === UNKNOWN && !requirement.allowUnknownQuota) {
    return {
      code: 'quota_unknown',
      reason: `Route ${key} quota is UNKNOWN; scheduling it requires an explicit policy opt-in.`
    }
  }
  return null
}

export type AdmissionRequest = {
  registry: RouteRegistry
  evidence: readonly RouteEvidence[]
  requested: RouteIdentity
  /** What the runtime actually resolved. Null fails closed. */
  effective: RouteIdentity | null
  requirement: RouteRequirement
  nowMs: number
  currentCommitSha?: string
  currentRuntimeVersion?: string
  ttlMs?: number
  /** Operator-declared first launch of a route that has never been proven.
   *
   *  Why this has to exist: every certification evidence kind is produced BY a
   *  real launch, so requiring PASS before any launch is a closed loop — no
   *  route could ever be certified, and no worker could start on an
   *  outcome-admitted Run. This opens exactly the UNTESTED case, and only when
   *  an operator asks for it by name. A route that has already FAILED, or whose
   *  evidence went STALE, is still refused: those have been proven, and the
   *  answer was no. */
  bootstrapUncertified?: boolean
}

export function admitRoute(request: AdmissionRequest): RouteAdmission {
  const { requested, effective, requirement } = request
  const key = routeKey(requested)
  const fail = (
    code: RouteAdmissionCode,
    state: CertificationState,
    reason: string
  ): RouteAdmission => ({
    ok: false,
    error: {
      code,
      routeKey: key,
      role: requirement.role,
      sessionMode: requirement.sessionMode,
      state,
      reason
    }
  })

  if (!effective) {
    return fail('identity_mismatch', 'UNTESTED', `Route ${key} has no effective runtime identity.`)
  }
  if (!sameRouteIdentity(requested, effective)) {
    return fail(
      'identity_mismatch',
      'FAIL',
      `Requested route ${key} but the runtime resolved ${routeKey(effective)}.`
    )
  }
  const route = findRoute(request.registry, requested)
  if (!route) {
    return fail('route_unknown', 'UNTESTED', `Route ${key} is not in the registry.`)
  }
  const eligibility = checkRouteEligibility(
    route,
    requirement,
    request.bootstrapUncertified === true
  )
  if (eligibility) {
    return fail(eligibility.code, 'UNTESTED', eligibility.reason)
  }
  const verdict = resolveRouteCertification(request.evidence, {
    identity: requested,
    role: requirement.role,
    sessionMode: requirement.sessionMode,
    nowMs: request.nowMs,
    currentCommitSha: request.currentCommitSha,
    currentRuntimeVersion: request.currentRuntimeVersion,
    ttlMs: request.ttlMs
  })
  if (verdict.state !== 'PASS') {
    const codeByState: Record<Exclude<CertificationState, 'PASS'>, RouteAdmissionCode> = {
      FAIL: 'route_failed',
      STALE: 'route_stale',
      UNTESTED: 'route_untested',
      UNSUPPORTED: 'route_unsupported'
    }
    // A never-proven route is the one state a bootstrap launch may open, and
    // only to produce the evidence certification will then judge.
    if (!(request.bootstrapUncertified && verdict.state === 'UNTESTED')) {
      return fail(codeByState[verdict.state], verdict.state, verdict.reason)
    }
    return { ok: true, route, verdict, bootstrap: true }
  }
  // Why last: a reviewer-oriented model may hold a builder role, but only once
  // its own evidence has certified that role. Policy never grants it.
  if (
    requirement.role === 'builder' &&
    isReviewerOrientedModel(requested.model) &&
    !route.roles.includes('builder')
  ) {
    return fail(
      'role_not_eligible',
      verdict.state,
      `Model ${requested.model} is reviewer-oriented; a builder role needs certified evidence.`
    )
  }
  return { ok: true, route, verdict }
}

/** Every currently admissible route for a requirement, as a SET. Deterministic
 *  ordering is by route key so output is stable, never a preference. */
export function listAdmissibleRoutes(
  request: Omit<AdmissionRequest, 'requested' | 'effective'>
): RouteRow[] {
  return request.registry
    .filter((route) => {
      const admission = admitRoute({
        ...request,
        requested: route.identity,
        effective: route.identity
      })
      return admission.ok
    })
    .sort((left, right) => routeKey(left.identity).localeCompare(routeKey(right.identity)))
}

export type RouteSelection =
  | { ok: true; route: RouteRow }
  | {
      ok: false
      code: 'no_candidate_order' | 'no_admissible_candidate'
      reason: string
      rejected: RouteAdmissionError[]
    }

/** Automatic fallback. Walks the caller's explicit candidate order and takes
 *  the first currently-admissible one. Orca contributes no preference: with no
 *  candidate order it refuses rather than picking. */
export function selectRoute(
  request: Omit<AdmissionRequest, 'requested' | 'effective'> & {
    candidates: readonly RouteIdentity[]
  }
): RouteSelection {
  if (request.candidates.length === 0) {
    return {
      ok: false,
      code: 'no_candidate_order',
      reason: 'No candidate route order was supplied; Orca does not choose a provider on its own.',
      rejected: []
    }
  }
  const rejected: RouteAdmissionError[] = []
  for (const candidate of request.candidates) {
    const admission = admitRoute({ ...request, requested: candidate, effective: candidate })
    if (admission.ok) {
      return { ok: true, route: admission.route }
    }
    rejected.push(admission.error)
  }
  return {
    ok: false,
    code: 'no_admissible_candidate',
    reason: 'No supplied candidate is currently certified for the required role and capabilities.',
    rejected
  }
}
