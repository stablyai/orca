import type { RouteIdentity, RouteRole, SessionMode } from './route-registry-types'
import { routeKey } from './route-registry-types'

/** B1 + CORRECTION 1 — certification is derived from recorded evidence, never
 *  asserted. A source-only test can exercise this state machine, but it cannot
 *  make a real route PASS: PASS requires evidence rows that only a live
 *  runtime certification run writes.
 *
 *  State machine (one derived state per route × role × session mode):
 *    trigger                        immediate state  writer            next state
 *    ----------------------------------------------------------------------------
 *    no evidence yet                UNTESTED         —                 any
 *    a required kind is UNSUPPORTED UNSUPPORTED      recordEvidence    PASS on support
 *    a required kind FAILs          FAIL             recordEvidence    PASS on re-cert
 *    all required kinds PASS        PASS             recordEvidence    STALE by clock
 *    evidence ages out / SHA moves  STALE (derived)  the clock         PASS on re-cert
 *  Authoritative clock: the runtime's, supplied as `nowMs`. Terminal resolver:
 *  `resolveRouteCertification` — every admission reads through it, so no caller
 *  can treat an old PASS as current.
 */

export const ROUTE_EVIDENCE_KINDS = [
  'fresh_launch',
  'effective_model_identity',
  'effective_reasoning_mode',
  'pretool_acceptance',
  'safe_launch_acceptance',
  'task_dispatch_worktree_binding',
  'completion_receipt',
  'retained_re_engagement',
  'duplicate_prevention',
  'failure_recovery',
  'role_execution'
] as const

export type RouteEvidenceKind = (typeof ROUTE_EVIDENCE_KINDS)[number]

export type EvidenceOutcome = 'PASS' | 'FAIL' | 'UNSUPPORTED'

export type RouteEvidence = {
  routeKey: string
  kind: RouteEvidenceKind
  role: RouteRole
  sessionMode: SessionMode
  outcome: EvidenceOutcome
  /** ISO-8601 UTC, written by the runtime. */
  observedAt: string
  runtimeVersion: string
  commitSha: string
  detail: string | null
}

export type CertificationState = 'PASS' | 'FAIL' | 'STALE' | 'UNTESTED' | 'UNSUPPORTED'

/** Why a day: evidence older than one working session has usually outlived the
 *  CLI build, entitlement or model alias it proved. */
export const ROUTE_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000

const FRESH_REQUIRED: readonly RouteEvidenceKind[] = [
  'fresh_launch',
  'effective_model_identity',
  'effective_reasoning_mode',
  'pretool_acceptance',
  'safe_launch_acceptance',
  'task_dispatch_worktree_binding',
  'completion_receipt',
  'duplicate_prevention',
  'failure_recovery',
  'role_execution'
]

const RETAINED_REQUIRED: readonly RouteEvidenceKind[] = [
  'retained_re_engagement',
  'effective_model_identity',
  'effective_reasoning_mode',
  'pretool_acceptance',
  'task_dispatch_worktree_binding',
  'completion_receipt',
  'duplicate_prevention',
  'role_execution'
]

export function requiredEvidenceKinds(sessionMode: SessionMode): readonly RouteEvidenceKind[] {
  return sessionMode === 'fresh' ? FRESH_REQUIRED : RETAINED_REQUIRED
}

export type CertificationQuery = {
  identity: RouteIdentity
  role: RouteRole
  sessionMode: SessionMode
  nowMs: number
  /** Certification is SHA- and version-bound; a mismatch reads as STALE. */
  currentCommitSha?: string
  currentRuntimeVersion?: string
  ttlMs?: number
}

export type CertificationVerdict = {
  state: CertificationState
  /** The kinds that stopped this from being PASS, when it is not. */
  blockingKinds: RouteEvidenceKind[]
  /** Newest evidence timestamp considered, or null when there is none. */
  latestEvidenceAt: string | null
  reason: string
}

function isStale(evidence: RouteEvidence, query: CertificationQuery): boolean {
  const observedMs = Date.parse(evidence.observedAt)
  if (!Number.isFinite(observedMs)) {
    return true
  }
  if (query.nowMs - observedMs > (query.ttlMs ?? ROUTE_EVIDENCE_TTL_MS)) {
    return true
  }
  if (query.currentCommitSha && evidence.commitSha !== query.currentCommitSha) {
    return true
  }
  return Boolean(query.currentRuntimeVersion) && evidence.runtimeVersion !== query.currentRuntimeVersion
}

function newestPerKind(
  evidence: readonly RouteEvidence[],
  query: CertificationQuery
): Map<RouteEvidenceKind, RouteEvidence> {
  const key = routeKey(query.identity)
  const newest = new Map<RouteEvidenceKind, RouteEvidence>()
  for (const record of evidence) {
    if (
      record.routeKey !== key ||
      record.role !== query.role ||
      record.sessionMode !== query.sessionMode
    ) {
      continue
    }
    const existing = newest.get(record.kind)
    if (!existing || Date.parse(record.observedAt) > Date.parse(existing.observedAt)) {
      newest.set(record.kind, record)
    }
  }
  return newest
}

export function resolveRouteCertification(
  evidence: readonly RouteEvidence[],
  query: CertificationQuery
): CertificationVerdict {
  const newest = newestPerKind(evidence, query)
  const required = requiredEvidenceKinds(query.sessionMode)
  const latestEvidenceAt =
    [...newest.values()]
      .map((record) => record.observedAt)
      .sort()
      .pop() ?? null

  const unsupported = required.filter((kind) => newest.get(kind)?.outcome === 'UNSUPPORTED')
  if (unsupported.length > 0) {
    return {
      state: 'UNSUPPORTED',
      blockingKinds: unsupported,
      latestEvidenceAt,
      reason: `Route does not support ${unsupported.join(', ')} for ${query.role}/${query.sessionMode}.`
    }
  }
  const failed = required.filter((kind) => newest.get(kind)?.outcome === 'FAIL')
  if (failed.length > 0) {
    return {
      state: 'FAIL',
      blockingKinds: failed,
      latestEvidenceAt,
      reason: `Route failed ${failed.join(', ')} for ${query.role}/${query.sessionMode}.`
    }
  }
  const missing = required.filter((kind) => !newest.has(kind))
  if (missing.length > 0) {
    return {
      state: 'UNTESTED',
      blockingKinds: missing,
      latestEvidenceAt,
      reason: `Route has no evidence for ${missing.join(', ')}.`
    }
  }
  const stale = required.filter((kind) => isStale(newest.get(kind) as RouteEvidence, query))
  if (stale.length > 0) {
    return {
      state: 'STALE',
      blockingKinds: stale,
      latestEvidenceAt,
      reason: `Evidence for ${stale.join(', ')} is stale for the current SHA/version/clock.`
    }
  }
  return {
    state: 'PASS',
    blockingKinds: [],
    latestEvidenceAt,
    reason: `All required evidence is current for ${query.role}/${query.sessionMode}.`
  }
}
