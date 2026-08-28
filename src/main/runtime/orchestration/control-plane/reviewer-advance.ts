import { admitRoute, selectRoute, type RouteRegistry } from './role-route-registry'
import type { RouteEvidence } from './route-certification-evidence'
import type { RouteIdentity, RouteRow, TaskCapability } from './route-registry-types'

/** B7 — a validated builder completion advances deterministically to exactly
 *  one next step. There is no fan-out, no auto-merge and no deploy.
 *
 *  State machine:
 *    trigger                       immediate state  writer               next state
 *    -------------------------------------------------------------------------------
 *    validated completion          advancing        planNextAfterBuild   review | fix_first | blocked
 *    corrections present           advancing        planNextAfterBuild   fix_first
 *    no certified reviewer route   advancing        planNextAfterBuild   blocked (protected)
 *  Idempotency: the plan is a pure function of (completion, registry, evidence,
 *  clock), so replaying it after a crash produces the identical single step.
 *
 *  Reviewer candidates are supplied by the caller (DCS/Sol). Orca never invents
 *  a preference order, so no provider is favoured by failure position.
 */

export type BuilderCompletion = {
  taskId: string
  dispatchId: string
  runId: string
  outcomeId: string | null
  /** Exact final SHA the completion receipt validated. */
  finalSha: string
  validated: boolean
}

export type RetainedBuilder = {
  dispatchId: string
  terminalHandle: string
  identity: RouteIdentity
  /** False once the terminal was released or the session was replaced. */
  sessionRetained: boolean
}

export type ReviewerAdvancePlan =
  | {
      kind: 'review'
      role: 'reviewer'
      route: RouteRow
      boundSha: string
      runId: string
      outcomeId: string | null
      sourceTaskId: string
    }
  | {
      kind: 'fix_first'
      builderDispatchId: string
      terminalHandle: string
      route: RouteRow
      /** One consolidated correction, never one Dispatch per finding. */
      corrections: readonly string[]
      boundSha: string
    }
  | {
      kind: 'blocked'
      code:
        | 'completion_not_validated'
        | 'no_certified_reviewer_route'
        | 'builder_session_not_retained'
        | 'builder_route_not_certified'
      reason: string
    }

export type ReviewerAdvanceRequest = {
  completion: BuilderCompletion
  registry: RouteRegistry
  evidence: readonly RouteEvidence[]
  nowMs: number
  currentCommitSha?: string
  currentRuntimeVersion?: string
  ttlMs?: number
  corrections?: readonly string[]
  retainedBuilder?: RetainedBuilder
  /** Explicit reviewer candidate order from the classifying layer. */
  reviewerCandidates?: readonly RouteIdentity[]
  /** The route that produced the commit under review. Excluded from reviewer
   *  selection so a session never grades its own work. */
  excludeRoute?: RouteIdentity | null
  reviewCapabilities?: readonly TaskCapability[]
  allowUnknownQuota?: boolean
}

export function planNextAfterBuild(request: ReviewerAdvanceRequest): ReviewerAdvancePlan {
  const { completion } = request
  if (!completion.validated) {
    return {
      kind: 'blocked',
      code: 'completion_not_validated',
      reason: `Dispatch ${completion.dispatchId} has no validated completion receipt; review cannot start.`
    }
  }

  const shared = {
    registry: request.registry,
    evidence: request.evidence,
    nowMs: request.nowMs,
    currentCommitSha: request.currentCommitSha,
    currentRuntimeVersion: request.currentRuntimeVersion,
    ttlMs: request.ttlMs
  }

  const corrections = request.corrections ?? []
  if (corrections.length > 0) {
    const builder = request.retainedBuilder
    if (!builder || !builder.sessionRetained) {
      return {
        kind: 'blocked',
        code: 'builder_session_not_retained',
        reason: 'FIX_FIRST requires the original builder session; it is no longer retained.'
      }
    }
    const admission = admitRoute({
      ...shared,
      requested: builder.identity,
      effective: builder.identity,
      requirement: {
        role: 'builder',
        sessionMode: 'retained',
        allowUnknownQuota: request.allowUnknownQuota
      }
    })
    if (!admission.ok) {
      return {
        kind: 'blocked',
        code: 'builder_route_not_certified',
        reason: admission.error.reason
      }
    }
    return {
      kind: 'fix_first',
      builderDispatchId: builder.dispatchId,
      terminalHandle: builder.terminalHandle,
      route: admission.route,
      corrections,
      boundSha: completion.finalSha
    }
  }

  const selection = selectRoute({
    ...shared,
    requirement: {
      role: 'reviewer',
      sessionMode: 'fresh',
      taskCapabilities: request.reviewCapabilities,
      allowUnknownQuota: request.allowUnknownQuota
    },
    // Why only the authoring route is dropped: the reviewer Task must be
    // independently configured, not the same session grading itself. It is the
    // route that WROTE the commit, which after a correction round is still the
    // builder — never whichever Dispatch happened to plan this phase.
    candidates: (request.reviewerCandidates ?? []).filter(
      (candidate) =>
        !request.excludeRoute ||
        candidate.agent !== request.excludeRoute.agent ||
        candidate.model !== request.excludeRoute.model ||
        candidate.reasoning !== request.excludeRoute.reasoning
    )
  })
  if (!selection.ok) {
    return {
      kind: 'blocked',
      code: 'no_certified_reviewer_route',
      reason: `${selection.reason} Emit the protected blocker rather than substituting an ineligible route.`
    }
  }
  return {
    kind: 'review',
    role: 'reviewer',
    route: selection.route,
    // Why the exact SHA: final review binds what was delivered, not the branch tip.
    boundSha: completion.finalSha,
    runId: completion.runId,
    outcomeId: completion.outcomeId,
    sourceTaskId: completion.taskId
  }
}
