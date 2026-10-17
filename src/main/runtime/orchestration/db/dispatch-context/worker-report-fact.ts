import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerReportOutcome } from '../../types'
import { z } from 'zod'

type AcceptedWorkerReport = {
  dispatchId: string
  outcome: WorkerReportOutcome
  observation?: { id: string; authorityId: string; homeReceivedAt: number }
}

export function recordAcceptedWorkerReportFact(
  db: OrchestrationDb,
  params: AcceptedWorkerReport
): void {
  if (!params.observation) {
    return
  }
  const existing = db
    .getAttemptObservationFacts(params.dispatchId)
    .find((fact) => fact.id === params.observation?.id)
  const latest = z
    .object({ sequence: z.number().nullable() })
    .parse(
      db.db
        .prepare(
          'SELECT MAX(sequence) AS sequence FROM attempt_observation_facts WHERE dispatch_id = ?'
        )
        .get(params.dispatchId)
    )
  const sequence = existing?.sequence ?? (latest.sequence ?? -1) + 1
  db.recordAttemptObservation({
    id: params.observation.id,
    dispatchId: params.dispatchId,
    sequence,
    authorityId: params.observation.authorityId,
    authorityClock: 'home',
    facet: 'worker_report',
    payload: { status: 'accepted', outcome: params.outcome, reportId: params.observation.id },
    sourceObservedAt: null,
    executionReceivedAt: null,
    homeReceivedAt: params.observation.homeReceivedAt
  })
}
