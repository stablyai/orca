import type {
  WorkerReportOutcome,
  FederationRelayDirection,
  FederationRelayItemRow
} from '../db/orchestration-records'
import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { parseFederatedWorkerReportOutcome } from './federated-worker-report-outcome'

export function listFederationRelay(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    direction: FederationRelayDirection
    afterSequence: number
    limit?: number
  }
): FederationRelayItemRow[] {
  return this.db
    .prepare(
      `SELECT * FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = ? AND sequence > ?
       ORDER BY sequence LIMIT ?`
    )
    .all(
      params.dispatchId,
      params.direction,
      params.afterSequence,
      Math.min(Math.max(params.limit ?? 50, 1), 50)
    ) as FederationRelayItemRow[]
}

/** A worker_done queued for the Run home that it has not acknowledged. */
export function hasPendingFederatedWorkerReport(
  this: OrchestrationDb,
  dispatchId: string
): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = 'to_home' AND kind = 'worker_done'
           AND acked_at IS NULL LIMIT 1`
      )
      .get(dispatchId) !== undefined
  )
}

export type FederationRelayAcknowledgment = {
  dispatchId: string
  direction: FederationRelayDirection
  throughSequence: number
  settleRemoteReports?: { sequence: number; outcome?: WorkerReportOutcome }[]
  // Only the home's acceptance proves settlement; arm after it, never at queue time.
  armAutoRelease?: boolean
}

/** Runs inside acknowledgeFederationRelay's transaction, before the items are marked acked. */
export function settleRemoteReportsInRelayAcknowledgment(
  this: OrchestrationDb,
  params: FederationRelayAcknowledgment
): void {
  const settledReports = params.settleRemoteReports ?? []
  for (const settledReport of settledReports) {
    const report = this.getFederationRelayItem(
      params.dispatchId,
      params.direction,
      settledReport.sequence
    )
    if (
      params.direction !== 'to_home' ||
      settledReport.sequence > params.throughSequence ||
      report?.kind !== 'worker_done' ||
      (settledReport.outcome !== undefined &&
        parseFederatedWorkerReportOutcome(report.payload) !== settledReport.outcome)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Federation acknowledgment for ${params.dispatchId} does not match its queued worker_done.`
      )
    }
  }
  const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
  if (
    params.direction === 'to_home' &&
    attachment !== undefined &&
    attachment.protocol_version >= ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
  ) {
    const acknowledgedReports = this.db
      .prepare(
        `SELECT sequence FROM federation_relay_items
           WHERE dispatch_id = ? AND direction = 'to_home' AND kind = 'worker_done'
             AND acked_at IS NULL AND sequence <= ?`
      )
      .all(params.dispatchId, params.throughSequence) as { sequence: number }[]
    const settledSequences = new Set(settledReports.map((report) => report.sequence))
    if (acknowledgedReports.some((report) => !settledSequences.has(report.sequence))) {
      throw new OrchestrationError(
        'request_mismatch',
        `Federation acknowledgment for ${params.dispatchId} omits a worker_done settlement.`
      )
    }
  }
  const terminalOutcomes = new Set(
    settledReports.flatMap((report) => (report.outcome ? [report.outcome] : []))
  )
  if (terminalOutcomes.size > 1) {
    throw new OrchestrationError(
      'request_mismatch',
      `Federation acknowledgment for ${params.dispatchId} contains conflicting settlements.`
    )
  }
  const terminalOutcome = settledReports.find((report) => report.outcome)?.outcome
  if (terminalOutcome) {
    this.settleRemoteAttachmentInRelayTransaction(
      params.dispatchId,
      terminalOutcome,
      'worker_report_settled'
    )
    if (params.armAutoRelease) {
      this.armWorkerTerminalAutoReleaseStatement(params.dispatchId)
    }
  }
}

export type FederationRelayReportAcknowledgmentMethods = {
  listFederationRelay: typeof listFederationRelay
  hasPendingFederatedWorkerReport: typeof hasPendingFederatedWorkerReport
  settleRemoteReportsInRelayAcknowledgment: typeof settleRemoteReportsInRelayAcknowledgment
}

export function attachFederationRelayReportAcknowledgment(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listFederationRelay,
    hasPendingFederatedWorkerReport,
    settleRemoteReportsInRelayAcknowledgment
  })
}
