import type { TuiAgent } from '../../../../shared/tui-agent'

/** B1 + CORRECTION 1 — the typed shape of one certified (or candidate) route.
 *
 *  Model identity is data here, never branching logic: nothing in this package
 *  reads a provider or model name to decide behaviour. Every decision is made
 *  from the declared fields below plus recorded evidence.
 *
 *  Anything the current architecture cannot observe stays the explicit literal
 *  `'UNKNOWN'`. Quota, availability, reset windows and effective model identity
 *  are never inferred.
 */

export const UNKNOWN = 'UNKNOWN' as const
export type Unknown = typeof UNKNOWN

/** A free-text field whose value may be the literal `UNKNOWN` sentinel.
 *  Typed as `string` because `string | 'UNKNOWN'` collapses to `string`; the
 *  sentinel is still the ONLY admissible stand-in for an unobserved value, and
 *  callers must write `UNKNOWN` rather than an empty string or a guess. */
export type TextOrUnknown = string

export type RouteRole = 'builder' | 'reviewer'
export const ROUTE_ROLES: readonly RouteRole[] = ['builder', 'reviewer']

/** `fresh` = a newly launched session. `retained` = re-engaging a session Orca
 *  already owns (FIX_FIRST, a follow-up Dispatch on the same terminal). */
export type SessionMode = 'fresh' | 'retained'
export const SESSION_MODES: readonly SessionMode[] = ['fresh', 'retained']

/** Open-ended by design: DCS/Sol supply the classification, Orca only matches
 *  it against what a route is certified for. Adding a capability must never
 *  require editing selection logic. */
export type TaskCapability = string

export const KNOWN_TASK_CAPABILITIES: readonly TaskCapability[] = [
  'bounded_implementation',
  'deep_architecture',
  'large_multi_file_build',
  'ui_implementation',
  'fast_fix',
  'heavy_review',
  'adversarial_review',
  'overflow_build'
]

/** How exactly the runtime can prove which model actually answered.
 *  `alias` (for example a generic `opus` or `gemini-flash-latest`) is NOT
 *  identity proof and can never certify an exact-model route. */
export type IdentityProof = 'exact' | 'alias' | Unknown

export type QuotaState = 'ok' | 'limited' | 'exhausted' | Unknown

export type RouteAvailability = 'available' | 'unavailable' | Unknown

export type RouteIdentity = {
  /** The Orca launcher that owns the session. */
  agent: TuiAgent
  /** Exact model/version id as the provider names it, or null when the harness
   *  exposes no model selection at all. */
  model: string | null
  /** Requested reasoning mode, or null when the harness has none. */
  reasoning: string | null
}

export type RouteReadiness = {
  availability: RouteAvailability
  /** True only when the harness reported usable credentials. Never a secret. */
  authenticated: boolean | Unknown
  providerStatus: TextOrUnknown
  quota: {
    state: QuotaState
    /** ISO-8601, or UNKNOWN. Never fabricated from a policy guess. */
    resetAt: TextOrUnknown
    remainingFraction: number | Unknown
  }
}

export type RouteRow = {
  identity: RouteIdentity
  /** Provider/harness the route runs through, as discovered — descriptive only. */
  provider: TextOrUnknown
  harness: TextOrUnknown
  /** Which of the declared roles this route is *eligible* to be certified for.
   *  Eligibility is a precondition for certification, never a substitute. */
  roles: readonly RouteRole[]
  taskCapabilities: readonly TaskCapability[]
  sessionModes: readonly SessionMode[]
  reasoningModes: readonly string[]
  contextLimitTokens: number | Unknown
  costClass: TextOrUnknown
  identityProof: IdentityProof
  /** Discovered from the authoritative launcher config, not asserted. */
  launcherSupported: boolean
  /** Discovered from the managed agent-hook targets. A route that the launcher
   *  supports but the hook layer rejects is a drift fault, not a usable route. */
  hookSupported: boolean
  readiness: RouteReadiness
  constraints: readonly string[]
  notes: string | null
}

export function routeKey(identity: RouteIdentity): string {
  return `${identity.agent}|${identity.model ?? ''}|${identity.reasoning ?? ''}`
}

export function sameRouteIdentity(left: RouteIdentity, right: RouteIdentity): boolean {
  return routeKey(left) === routeKey(right)
}

export function unknownReadiness(): RouteReadiness {
  return {
    availability: UNKNOWN,
    authenticated: UNKNOWN,
    providerStatus: UNKNOWN,
    quota: { state: UNKNOWN, resetAt: UNKNOWN, remainingFraction: UNKNOWN }
  }
}

/** Classification of why a route attempt ended, so a repair can target the real
 *  fault instead of silently swapping in another provider. */
export type RouteFailureClass =
  | 'control_plane'
  | 'provider_unavailable'
  | 'quota'
  | 'model_execution'
  | 'task_failure'

export type RouteFailure = {
  class: RouteFailureClass
  routeKey: string
  reason: string
  /** Only a control-plane fault is safe for Orca to repair and retry itself. */
  safeToRepairInPlace: boolean
}

export function classifyRouteFailure(args: {
  routeKey: string
  class: RouteFailureClass
  reason: string
}): RouteFailure {
  return {
    class: args.class,
    routeKey: args.routeKey,
    reason: args.reason,
    safeToRepairInPlace: args.class === 'control_plane'
  }
}
