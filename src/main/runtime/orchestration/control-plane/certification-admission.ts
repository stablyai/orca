import type { OrchestrationDb } from '../db'
import {
  observeCertificationEvidence,
  type CertificationObservationSource
} from './certification-event-source'
import { readDispatchRouteIdentity } from './dispatch-route-identity'
import {
  ROUTE_EVIDENCE_KINDS,
  requiredEvidenceKinds,
  resolveRouteCertification,
  type EvidenceOutcome,
  type RouteEvidence,
  type RouteEvidenceKind
} from './route-certification-evidence'
import { RouteRegistryStore } from './route-registry-store'
import {
  routeKey,
  sameRouteIdentity,
  type RouteIdentity,
  type RouteRole,
  type SessionMode
} from './route-registry-types'

/** B1 (correction 2) — the bounded admission rules for writing certification
 *  evidence, so live certification is an operation the runtime performs rather
 *  than a claim anyone can assert.
 *
 *  A PASS row is admissible only when the runtime can point at a real launch:
 *   - the Dispatch exists;
 *   - it carries a `process_incarnation`, which only the terminal-authority
 *     path writes after a real agent pane became ready;
 *   - the route the Dispatch actually launched on (what the provider was
 *     observed running, else the persisted launch receipt) matches the claimed
 *     identity exactly.
 *  A synthetic unit test has no process incarnation and no launch receipt, so
 *  it can exercise every rejection path but can never mint PASS.
 *
 *  FAIL and UNSUPPORTED need no launch: they only ever restrict routing, so a
 *  cheap way to record them keeps the registry honest.
 */

export type CertificationAdmissionCode =
  | 'unknown_dispatch'
  | 'dispatch_not_launched'
  | 'launch_route_unknown'
  | 'identity_mismatch'
  | 'invalid_kind'
  | 'invalid_sha'
  | 'evidence_not_observed'
  | 'commit_unknown'
  | 'sha_mismatch'
  | 'runtime_mismatch'

export type CertificationAdmission =
  | { ok: true; evidence: RouteEvidence }
  | { ok: false; code: CertificationAdmissionCode; reason: string }

const SHA_PATTERN = /^[0-9a-f]{7,64}$/

export type CertificationRequest = {
  identity: RouteIdentity
  role: RouteRole
  sessionMode: SessionMode
  kind: string
  outcome: EvidenceOutcome
  /** Required for PASS: the Dispatch whose real launch is the evidence. */
  dispatchId?: string
  commitSha: string
  detail?: string | null
}

export type CertificationStamp = {
  observedAtIso: string
  runtimeVersion: string
  /** The commit the RUNTIME was built from. The caller's `--sha` is checked
   *  against this and never substituted for it. Null means the runtime cannot
   *  establish its own commit, and SHA-bound evidence then fails closed. */
  commitSha: string | null
}

/** No runtime facts at all: every PASS request fails closed. */
const UNOBSERVABLE_SOURCE: CertificationObservationSource = {
  observedEffectiveIdentity: () => null,
  agentStatusSnapshot: () => []
}

export function admitCertificationEvidence(args: {
  db: OrchestrationDb
  request: CertificationRequest
  stamp: CertificationStamp
  /** Runtime facts the database cannot answer. Omitted only by callers that
   *  never record PASS; without it a PASS request fails closed. */
  source?: CertificationObservationSource
}): CertificationAdmission {
  const { request } = args
  if (!(ROUTE_EVIDENCE_KINDS as readonly string[]).includes(request.kind)) {
    return {
      ok: false,
      code: 'invalid_kind',
      reason: `Unknown evidence kind ${request.kind}; expected one of ${ROUTE_EVIDENCE_KINDS.join(', ')}.`
    }
  }
  if (!SHA_PATTERN.test(request.commitSha)) {
    return {
      ok: false,
      code: 'invalid_sha',
      reason: 'Certification evidence must be bound to a hexadecimal commit SHA.'
    }
  }
  if (request.outcome === 'PASS') {
    // Why at RECORD time: evidence is only ever about the code that was
    // running. A caller may assert which commit that was, but the runtime is
    // what knows, so a mismatch is rejected here rather than being written and
    // discovered later as staleness.
    if (!args.stamp.commitSha) {
      return {
        ok: false,
        code: 'commit_unknown',
        reason:
          'This runtime cannot establish the commit it was built from, so it cannot certify SHA-bound evidence.'
      }
    }
    if (request.commitSha !== args.stamp.commitSha) {
      return {
        ok: false,
        code: 'sha_mismatch',
        reason: `Evidence claims commit ${request.commitSha}, but this runtime was built from ${args.stamp.commitSha}.`
      }
    }
    const guard = requireRealLaunch(args.db, request, args.source)
    if (guard) {
      return guard
    }
    // Why a second gate: a real launch proves the ROUTE ran, never that THIS
    // evidence kind happened. The caller requests the kind; the runtime decides
    // whether its own records show the event, and fails closed when they do not.
    const observation = observeCertificationEvidence({
      db: args.db,
      source: args.source ?? UNOBSERVABLE_SOURCE,
      request: {
        identity: request.identity,
        role: request.role,
        sessionMode: request.sessionMode,
        kind: request.kind as RouteEvidenceKind,
        dispatchId: request.dispatchId as string
      }
    })
    if (!observation.observed) {
      return {
        ok: false,
        code: 'evidence_not_observed',
        reason: `${observation.code}: ${observation.reason}`
      }
    }
  }
  return {
    ok: true,
    evidence: {
      routeKey: routeKey(request.identity),
      kind: request.kind as RouteEvidenceKind,
      role: request.role,
      sessionMode: request.sessionMode,
      outcome: request.outcome,
      observedAt: args.stamp.observedAtIso,
      runtimeVersion: args.stamp.runtimeVersion,
      // Why the stamp, not the request, for PASS: the runtime owns the commit.
      // FAIL/UNSUPPORTED keep the caller's value because they only restrict.
      commitSha: request.outcome === 'PASS' ? (args.stamp.commitSha as string) : request.commitSha,
      detail: request.detail ?? null
    }
  }
}

function requireRealLaunch(
  db: OrchestrationDb,
  request: CertificationRequest,
  source?: CertificationObservationSource
): CertificationAdmission | null {
  if (!request.dispatchId) {
    return {
      ok: false,
      code: 'unknown_dispatch',
      reason: 'PASS evidence requires the Dispatch whose real launch proves it.'
    }
  }
  const dispatch = db.getDispatchContextById(request.dispatchId)
  if (!dispatch) {
    return {
      ok: false,
      code: 'unknown_dispatch',
      reason: `Dispatch ${request.dispatchId} does not exist.`
    }
  }
  if (!dispatch.process_incarnation) {
    return {
      ok: false,
      code: 'dispatch_not_launched',
      reason: `Dispatch ${request.dispatchId} has no recorded process incarnation, so no real launch happened.`
    }
  }
  // Why observed first: until the provider is observed the receipt still holds
  // the REQUESTED alias, so the route that actually ran was refused here before
  // the observation it depends on could ever run.
  const launched =
    source?.observedEffectiveIdentity(request.dispatchId) ??
    readDispatchRouteIdentity(db, request.dispatchId)
  if (!launched) {
    return {
      ok: false,
      code: 'launch_route_unknown',
      reason: `Dispatch ${request.dispatchId} has no persisted launch receipt to read a route from.`
    }
  }
  if (!sameRouteIdentity(launched, request.identity)) {
    return {
      ok: false,
      code: 'identity_mismatch',
      reason: `Dispatch ${request.dispatchId} launched on ${routeKey(launched)}, not ${routeKey(request.identity)}.`
    }
  }
  return null
}

export type CertificationMatrixCell = {
  role: RouteRole
  sessionMode: SessionMode
  state: string
  blockingKinds: RouteEvidenceKind[]
  latestEvidenceAt: string | null
}

export type CertificationMatrixRow = {
  routeKey: string
  identity: RouteIdentity
  identityProof: string
  launcherSupported: boolean
  hookSupported: boolean
  cells: CertificationMatrixCell[]
  /** Evidence kinds that still have no row at all, per role/session mode. */
  missing: Record<string, RouteEvidenceKind[]>
}

/** The requested fresh/retained × builder/reviewer matrix, with the exact
 *  outstanding evidence kinds named so an operator knows what to run next. */
export function buildCertificationMatrix(args: {
  db: OrchestrationDb
  nowMs: number
  currentCommitSha?: string
  currentRuntimeVersion?: string
}): CertificationMatrixRow[] {
  const store = new RouteRegistryStore(args.db)
  const evidence = store.listRouteEvidence()
  return store.listRoutes().map((route) => {
    const cells: CertificationMatrixCell[] = []
    const missing: Record<string, RouteEvidenceKind[]> = {}
    for (const role of ['builder', 'reviewer'] as RouteRole[]) {
      for (const sessionMode of ['fresh', 'retained'] as SessionMode[]) {
        const verdict = resolveRouteCertification(evidence, {
          identity: route.identity,
          role,
          sessionMode,
          nowMs: args.nowMs,
          currentCommitSha: args.currentCommitSha,
          currentRuntimeVersion: args.currentRuntimeVersion
        })
        cells.push({
          role,
          sessionMode,
          state: verdict.state,
          blockingKinds: verdict.blockingKinds,
          latestEvidenceAt: verdict.latestEvidenceAt
        })
        const seen = new Set(
          evidence
            .filter(
              (row) =>
                row.routeKey === routeKey(route.identity) &&
                row.role === role &&
                row.sessionMode === sessionMode
            )
            .map((row) => row.kind)
        )
        missing[`${role}:${sessionMode}`] = requiredEvidenceKinds(sessionMode).filter(
          (kind) => !seen.has(kind)
        )
      }
    }
    return {
      routeKey: routeKey(route.identity),
      identity: route.identity,
      identityProof: route.identityProof,
      launcherSupported: route.launcherSupported,
      hookSupported: route.hookSupported,
      cells,
      missing
    }
  })
}
