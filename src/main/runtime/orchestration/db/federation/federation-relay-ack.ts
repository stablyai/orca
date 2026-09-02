import type {
  WorkerReportOutcome,
  FederationRelayDirection,
  FederationRelayItemRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../../../shared/protocol-version'
import { parseFederatedWorkerReportOutcome } from '../federated-worker-report-outcome'
import type { OrchestrationDb } from '../orchestration-db'

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

export function listPendingFederationRelay(
  this: OrchestrationDb,
  dispatchId: string,
  direction: FederationRelayDirection,
  limit = 50
): FederationRelayItemRow[] {
  return this.db
    .prepare(
      `SELECT * FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL
       ORDER BY sequence LIMIT ?`
    )
    .all(dispatchId, direction, Math.min(Math.max(limit, 1), 50)) as FederationRelayItemRow[]
}

export function acknowledgeFederationRelay(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    direction: FederationRelayDirection
    throughSequence: number
    settleRemoteReports?: { sequence: number; outcome?: WorkerReportOutcome }[]
  }
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
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
    }
    this.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = COALESCE(acked_at, datetime('now'))
         WHERE dispatch_id = ? AND direction = ? AND sequence <= ?`
      )
      .run(params.dispatchId, params.direction, params.throughSequence)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function setFederatedHomeImportSequence(
  this: OrchestrationDb,
  dispatchId: string,
  sequence: number
): void {
  this.db
    .prepare(
      `UPDATE federated_dispatches
       SET to_home_imported_sequence = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND to_home_imported_sequence < ?`
    )
    .run(sequence, dispatchId, sequence)
}

export function recordFederatedHomeAcknowledgment(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    sequence: number
  }
): void {
  const federated = this.getFederatedDispatch(params.dispatchId)
  if (
    !federated ||
    !Number.isInteger(params.sequence) ||
    params.sequence < 0 ||
    params.sequence > federated.to_home_imported_sequence
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Federation acknowledgment for ${params.dispatchId} exceeds imported relay state.`
    )
  }
  this.db
    .prepare(
      `UPDATE federated_dispatches
       SET remote_runtime_epoch = ?,
           to_home_acknowledged_sequence = CASE
             WHEN remote_runtime_epoch = ?
               THEN MAX(to_home_acknowledged_sequence, ?)
             ELSE ?
           END,
           updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(
      params.remoteRuntimeEpoch,
      params.remoteRuntimeEpoch,
      params.sequence,
      params.sequence,
      params.dispatchId
    )
}

export type FederationRelayAckMethods = {
  listFederationRelay: typeof listFederationRelay
  listPendingFederationRelay: typeof listPendingFederationRelay
  acknowledgeFederationRelay: typeof acknowledgeFederationRelay
  setFederatedHomeImportSequence: typeof setFederatedHomeImportSequence
  recordFederatedHomeAcknowledgment: typeof recordFederatedHomeAcknowledgment
}

export function attachFederationRelayAck(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listFederationRelay,
    listPendingFederationRelay,
    acknowledgeFederationRelay,
    setFederatedHomeImportSequence,
    recordFederatedHomeAcknowledgment
  })
}
