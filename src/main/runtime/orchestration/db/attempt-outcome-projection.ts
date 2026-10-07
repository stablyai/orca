import type {
  AttemptFreshness,
  AttemptLivenessObservation,
  AttemptObservationFact,
  AttemptObservationFacet,
  AttemptOutcomeProjection,
  AttemptProjectedOutcome,
  AttemptWorkerReport
} from './attempt-observation-types'

const DEFAULT_FRESH_AFTER_MS = 60_000
const FUTURE_TOLERANCE_MS = 5_000

function latestByFacet(
  facts: readonly AttemptObservationFact[]
): Map<AttemptObservationFacet, AttemptObservationFact> {
  const latest = new Map<AttemptObservationFacet, AttemptObservationFact>()
  for (const fact of facts) {
    const prior = latest.get(fact.facet)
    if (!prior || prior.sequence < fact.sequence) {
      latest.set(fact.facet, fact)
    }
  }
  return latest
}

function authorityTimestamp(fact: AttemptObservationFact): number | null {
  return fact.authorityClock === 'execution'
    ? (fact.executionReceivedAt ?? null)
    : fact.homeReceivedAt
}

function projectFreshness(
  fact: AttemptObservationFact | undefined,
  clock: { execution?: number; home: number },
  freshAfterMs: number
): AttemptFreshness {
  if (!fact) {
    return { status: 'never' }
  }
  const observedAt = authorityTimestamp(fact)
  const now = fact.authorityClock === 'execution' ? clock.execution : clock.home
  if (observedAt === null || now === undefined) {
    return { status: 'unverifiable', clock: fact.authorityClock }
  }
  if (observedAt - now > FUTURE_TOLERANCE_MS) {
    return { status: 'future', clock: fact.authorityClock, observedAt }
  }
  const ageMs = Math.max(0, now - observedAt)
  return {
    status: ageMs <= freshAfterMs ? 'fresh' : 'stale',
    clock: fact.authorityClock,
    observedAt,
    ageMs
  }
}

function projectLiveness(
  fact: AttemptObservationFact | undefined,
  clock: { execution?: number; home: number },
  freshAfterMs: number
): AttemptLivenessObservation & { freshness: AttemptFreshness } {
  const freshness = projectFreshness(fact, clock, freshAfterMs)
  if (!fact) {
    return { status: 'unverifiable', reason: 'never observed', freshness }
  }
  const observed = fact.payload as AttemptLivenessObservation
  if (observed.status === 'exited') {
    return { status: 'exited', freshness }
  }
  if (observed.status === 'unverifiable') {
    return { ...observed, freshness }
  }
  if (freshness.status !== 'fresh') {
    return {
      status: 'unverifiable',
      reason: `live observation is ${freshness.status}`,
      freshness
    }
  }
  return { ...observed, freshness }
}

function observedUnverifiedOutcome(args: {
  processTurn: AttemptOutcomeProjection['processTurn']
  liveness: AttemptOutcomeProjection['liveness']
}): {
  outcome: AttemptProjectedOutcome
  source: AttemptOutcomeProjection['outcomeSource']
  reason: string | null
} {
  if (
    args.processTurn?.turn === 'finished' ||
    args.processTurn?.process === 'stopped' ||
    args.liveness.status === 'exited'
  ) {
    return {
      outcome: 'finished_unverified',
      source: 'observation',
      reason: 'execution finished without an accepted worker report'
    }
  }
  if (args.liveness.status === 'live') {
    return { outcome: 'in_progress', source: 'observation', reason: null }
  }
  return { outcome: 'outcome_unknown', source: 'none', reason: 'execution outcome is unverified' }
}

function reportOutcome(report: AttemptWorkerReport | null): AttemptProjectedOutcome | null {
  return report?.status === 'accepted' ? report.outcome : null
}

export function projectAttemptOutcome(args: {
  dispatchId: string
  taskId: string
  facts: readonly AttemptObservationFact[]
  activeSibling?: boolean
  authorityNow: { execution?: number; home: number }
  freshAfterMs?: number
}): AttemptOutcomeProjection {
  const latest = latestByFacet(args.facts)
  const processTurn = latest.get('process_turn')?.payload as AttemptOutcomeProjection['processTurn']
  const artifactGit = latest.get('artifact_git')?.payload as AttemptOutcomeProjection['artifactGit']
  const workerReport = latest.get('worker_report')?.payload as AttemptWorkerReport | undefined
  const coordinatorAcknowledgment = latest.get('coordinator_ack')
    ?.payload as AttemptOutcomeProjection['coordinatorAcknowledgment']
  const liveness = projectLiveness(
    latest.get('liveness'),
    args.authorityNow,
    args.freshAfterMs ?? DEFAULT_FRESH_AFTER_MS
  )
  const explicitReportOutcome = reportOutcome(workerReport ?? null)
  const additive = latest.get('outcome')?.payload as
    | { outcome: 'outcome_unknown' | 'finished_unverified'; reason: string }
    | undefined
  const derived = observedUnverifiedOutcome({ processTurn: processTurn ?? null, liveness })
  const outcome = explicitReportOutcome ?? additive?.outcome ?? derived.outcome
  const outcomeSource = explicitReportOutcome
    ? 'worker_report'
    : additive
      ? 'additive_fact'
      : derived.source
  const outcomeReason = explicitReportOutcome ? null : (additive?.reason ?? derived.reason)
  const activeSibling = args.activeSibling ?? false
  return {
    dispatchId: args.dispatchId,
    taskId: args.taskId,
    outcome,
    taskOutcome: activeSibling && outcome !== 'in_progress' ? 'outcome_unknown' : outcome,
    outcomeSource,
    outcomeReason,
    activeSibling,
    processTurn: processTurn ?? null,
    artifactGit: artifactGit ?? null,
    workerReport: workerReport ?? null,
    coordinatorAcknowledgment: coordinatorAcknowledgment ?? null,
    liveness
  }
}
