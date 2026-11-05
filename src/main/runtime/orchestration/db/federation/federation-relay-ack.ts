import { potentiallyLiveRemoteAttachmentSql } from './remote-attachment-liveness'
import { ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION } from '../../../../../shared/orchestration-runtime-capabilities'
import type {
  WorkerReportOutcome,
  FederationRelayDirection,
  FederationRelayItemRow,
  RemoteDispatchAttachmentRow
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
    // Only the home's acceptance proves settlement; arm after it, never at queue time.
    armAutoRelease?: boolean
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
      if (params.armAutoRelease) {
        this.armWorkerTerminalAutoReleaseStatement(params.dispatchId)
      }
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

export type FinishedRemoteWorker = Pick<
  RemoteDispatchAttachmentRow,
  'dispatch_id' | 'pane_key' | 'terminal_handle' | 'updated_at'
> & { mail: boolean; released: boolean }

/** For a Run home: its finished workers here, whether each left mail it has not taken, and whether its terminal closed. */
export function listFinishedRemoteWorkers(
  this: OrchestrationDb,
  homePeerFingerprint: string
): FinishedRemoteWorker[] {
  return this.db
    .prepare(
      `SELECT a.dispatch_id, a.pane_key, a.terminal_handle, a.updated_at,
         EXISTS (SELECT 1 FROM federation_relay_items r WHERE r.dispatch_id = a.dispatch_id
                  AND r.direction = 'to_home' AND r.acked_at IS NULL) AS mail,
         EXISTS (SELECT 1 FROM worker_terminal_resources t WHERE t.owner_dispatch_id = a.dispatch_id
                  AND t.release_state = 'released') AS released
       FROM remote_dispatch_attachments a
       WHERE a.home_peer_fingerprint = ? AND a.protocol_version >= ?
         AND NOT (${potentiallyLiveRemoteAttachmentSql('a.state')})`
    )
    .all(homePeerFingerprint, ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION)
    .flatMap((row) =>
      typeof row?.dispatch_id === 'string' && typeof row.updated_at === 'string'
        ? [
            {
              dispatch_id: row.dispatch_id,
              pane_key: typeof row.pane_key === 'string' ? row.pane_key : null,
              terminal_handle: typeof row.terminal_handle === 'string' ? row.terminal_handle : null,
              updated_at: row.updated_at,
              mail: row.mail === 1,
              released: row.released === 1
            }
          ]
        : []
    )
}

export type FederationRelayAckMethods = {
  listFederationRelay: typeof listFederationRelay
  listPendingFederationRelay: typeof listPendingFederationRelay
  acknowledgeFederationRelay: typeof acknowledgeFederationRelay
  setFederatedHomeImportSequence: typeof setFederatedHomeImportSequence
  recordFederatedHomeAcknowledgment: typeof recordFederatedHomeAcknowledgment
  hasPendingFederatedWorkerReport: typeof hasPendingFederatedWorkerReport
  listFinishedRemoteWorkers: typeof listFinishedRemoteWorkers
}

export function attachFederationRelayAck(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listFederationRelay,
    listPendingFederationRelay,
    acknowledgeFederationRelay,
    setFederatedHomeImportSequence,
    recordFederatedHomeAcknowledgment,
    hasPendingFederatedWorkerReport,
    listFinishedRemoteWorkers
  })
}
