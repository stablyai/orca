import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { closeDispatchTranscriptSegment } from './dispatch-transcript-close'
import { matchesLeaseTransferReceipt } from './dispatch-transcript-lease-transfer'
import { readDispatchTranscript } from './dispatch-transcript-read'
import { createDispatchTranscriptTables } from './dispatch-transcript-schema'
import {
  assertDispatchTranscriptCursor,
  deserializeDispatchTranscriptSegment,
  matchesStartedSegment,
  matchesTerminalIdentity,
  matchesTransferRequest,
  type DispatchTranscriptSegmentRow
} from './dispatch-transcript-segment'
import type {
  DispatchTranscriptReadResult,
  DispatchTranscriptReadSelector,
  DispatchTranscriptSegment,
  DispatchTranscriptTerminalIdentity,
  DispatchTranscriptTransferReceipt,
  StartDispatchTranscriptSegmentParams,
  TransferDispatchTranscriptSegmentParams
} from './dispatch-transcript-types'

export class DispatchTranscriptStore {
  constructor(private readonly orchestrationDb: OrchestrationDb) {
    createDispatchTranscriptTables(orchestrationDb)
  }

  startSegment(params: StartDispatchTranscriptSegmentParams): DispatchTranscriptSegment {
    assertDispatchTranscriptCursor(params.startCursor)
    const replay = this.getSegment(params.dispatchId)
    if (replay) {
      if (!matchesStartedSegment(replay, params)) {
        throw conflict('Dispatch transcript segment identity differs.')
      }
      return replay
    }
    this.assertLeaseIdentity(params)
    const predecessor = this.findLatestIncarnationSegment(params)
    if (predecessor) {
      throw conflict('A reused terminal incarnation requires an explicit transfer receipt.')
    }
    this.orchestrationDb.db
      .prepare(
        `INSERT INTO dispatch_transcript_segments (
          dispatch_id, lease_id, run_id, task_id, attempt_id, predecessor_dispatch_id,
          execution_host_id, workspace_key, terminal_handle, pane_key, pty_incarnation,
          process_root_id, start_cursor
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.dispatchId,
        params.leaseId,
        params.runId,
        params.taskId,
        params.attemptId,
        params.executionHostId,
        params.workspaceKey,
        params.terminalHandle,
        params.paneKey,
        params.ptyIncarnation,
        params.processRootId,
        params.startCursor
      )
    return this.getSegment(params.dispatchId) as DispatchTranscriptSegment
  }

  transferSegment(
    params: TransferDispatchTranscriptSegmentParams
  ): DispatchTranscriptTransferReceipt {
    assertDispatchTranscriptCursor(params.transferCursor)
    this.orchestrationDb.db.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.getTransferReceipt(params.requestId)
      if (replay) {
        if (!matchesTransferRequest(replay, params)) {
          throw conflict('Dispatch transcript transfer receipt identity differs.')
        }
        this.orchestrationDb.db.exec('COMMIT')
        return replay
      }
      const leaseReceipt = this.orchestrationDb.getMaestroWorkerLeaseTransferReceipt(
        params.leaseTransferRequestId
      )
      if (!leaseReceipt || !matchesLeaseTransferReceipt(leaseReceipt, params)) {
        throw conflict('The canonical terminal lease transfer receipt does not match.')
      }
      const predecessor = this.getSegment(params.predecessorDispatchId)
      if (
        !predecessor ||
        predecessor.leaseId !== params.predecessorLeaseId ||
        predecessor.attemptId === params.successorAttemptId ||
        !matchesTerminalIdentity(predecessor, params) ||
        (predecessor.endCursor !== null && predecessor.endCursor !== params.transferCursor)
      ) {
        throw conflict('The predecessor transcript segment is not transferable.')
      }
      if (params.predecessorDispatchId === params.successorDispatchId) {
        throw conflict('A transcript transfer requires a new Dispatch.')
      }
      if (this.getSegment(params.successorDispatchId)) {
        throw conflict('The successor transcript segment is already reserved.')
      }
      const latest = this.findLatestIncarnationSegment(params)
      if (latest?.dispatchId !== predecessor.dispatchId) {
        throw conflict('The predecessor is not the active terminal transcript segment.')
      }
      const lastEntry = this.orchestrationDb.db
        .prepare(
          `SELECT max(cursor) AS cursor FROM dispatch_transcript_entries WHERE dispatch_id = ?`
        )
        .get(predecessor.dispatchId) as { cursor: number | null }
      if (lastEntry.cursor !== null && lastEntry.cursor >= params.transferCursor) {
        throw conflict('The transfer cursor would truncate predecessor transcript output.')
      }
      this.orchestrationDb.db
        .prepare(
          `UPDATE dispatch_transcript_segments SET end_cursor = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND (end_cursor IS NULL OR end_cursor = ?)`
        )
        .run(params.transferCursor, predecessor.dispatchId, params.transferCursor)
      this.orchestrationDb.db
        .prepare(
          `INSERT INTO dispatch_transcript_segments (
            dispatch_id, lease_id, run_id, task_id, attempt_id, predecessor_dispatch_id,
            execution_host_id, workspace_key, terminal_handle, pane_key, pty_incarnation,
            process_root_id, start_cursor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.successorDispatchId,
          params.successorLeaseId,
          params.successorRunId,
          params.successorTaskId,
          params.successorAttemptId,
          params.predecessorDispatchId,
          params.executionHostId,
          params.workspaceKey,
          params.terminalHandle,
          params.paneKey,
          params.ptyIncarnation,
          params.processRootId,
          params.transferCursor
        )
      const receipt: DispatchTranscriptTransferReceipt = {
        version: 1,
        ...params,
        transferredAt: new Date().toISOString()
      }
      this.orchestrationDb.db
        .prepare(
          `INSERT INTO dispatch_transcript_transfer_receipts (
             request_id, lease_transfer_request_id, receipt_json
           ) VALUES (?, ?, ?)`
        )
        .run(params.requestId, params.leaseTransferRequestId, JSON.stringify(receipt))
      this.orchestrationDb.db.exec('COMMIT')
      return receipt
    } catch (error) {
      this.orchestrationDb.db.exec('ROLLBACK')
      throw error
    }
  }

  closeSegment(params: {
    dispatchId: string
    endCursor: number
    terminal: DispatchTranscriptTerminalIdentity
  }): DispatchTranscriptSegment {
    return closeDispatchTranscriptSegment({
      db: this.orchestrationDb,
      ...params,
      getSegment: (dispatchId) => this.getSegment(dispatchId)
    })
  }

  appendEntries(params: {
    dispatchId: string
    terminal: DispatchTranscriptTerminalIdentity
    entries: { cursor: number; payload: unknown }[]
  }): void {
    this.orchestrationDb.db.exec('BEGIN IMMEDIATE')
    try {
      const segment = this.getSegment(params.dispatchId)
      if (!segment || !matchesTerminalIdentity(segment, params.terminal)) {
        throw conflict('The transcript append identity differs.')
      }
      const insert = this.orchestrationDb.db.prepare(
        `INSERT INTO dispatch_transcript_entries (dispatch_id, cursor, payload_json)
         VALUES (?, ?, ?) ON CONFLICT(dispatch_id, cursor) DO NOTHING`
      )
      for (const entry of params.entries) {
        assertDispatchTranscriptCursor(entry.cursor)
        if (
          entry.cursor < segment.startCursor ||
          (segment.endCursor !== null && entry.cursor >= segment.endCursor)
        ) {
          throw conflict('A transcript entry falls outside its Dispatch segment.')
        }
        const payloadJson = JSON.stringify(entry.payload)
        if (payloadJson === undefined) {
          throw new OrchestrationError(
            'invalid_argument',
            'Transcript payload is not serializable.'
          )
        }
        const result = insert.run(params.dispatchId, entry.cursor, payloadJson)
        if (result.changes === 0) {
          const stored = this.orchestrationDb.db
            .prepare(
              `SELECT payload_json FROM dispatch_transcript_entries
               WHERE dispatch_id = ? AND cursor = ?`
            )
            .get(params.dispatchId, entry.cursor) as { payload_json: string }
          if (stored.payload_json !== payloadJson) {
            throw conflict('A transcript cursor already contains different output.')
          }
        }
      }
      this.orchestrationDb.db.exec('COMMIT')
    } catch (error) {
      this.orchestrationDb.db.exec('ROLLBACK')
      throw error
    }
  }

  read(params: {
    dispatchId: string
    selector?: DispatchTranscriptReadSelector
    cursor?: string
    limit?: number
  }): DispatchTranscriptReadResult {
    return readDispatchTranscript({
      db: this.orchestrationDb,
      ...params,
      getSegment: (dispatchId) => this.getSegment(dispatchId)
    })
  }

  getSegment(dispatchId: string): DispatchTranscriptSegment | undefined {
    const row = this.orchestrationDb.db
      .prepare('SELECT * FROM dispatch_transcript_segments WHERE dispatch_id = ?')
      .get(dispatchId) as DispatchTranscriptSegmentRow | undefined
    return row ? deserializeDispatchTranscriptSegment(row) : undefined
  }

  getTransferReceipt(requestId: string): DispatchTranscriptTransferReceipt | undefined {
    const row = this.orchestrationDb.db
      .prepare(
        'SELECT receipt_json FROM dispatch_transcript_transfer_receipts WHERE request_id = ?'
      )
      .get(requestId) as { receipt_json: string } | undefined
    return row ? (JSON.parse(row.receipt_json) as DispatchTranscriptTransferReceipt) : undefined
  }

  private assertLeaseIdentity(params: StartDispatchTranscriptSegmentParams): void {
    const lease = this.orchestrationDb.getMaestroTerminalLease(params.leaseId)
    const leaseTerminalIdentity =
      lease &&
      lease.terminalHandle !== null &&
      lease.paneKey !== null &&
      lease.ptyIncarnation !== null
        ? {
            executionHostId: lease.executionHostId,
            workspaceKey: lease.workspaceKey,
            terminalHandle: lease.terminalHandle,
            paneKey: lease.paneKey,
            ptyIncarnation: lease.ptyIncarnation,
            processRootId: lease.processRootId
          }
        : null
    if (
      !lease ||
      lease.role !== 'worker' ||
      lease.ownerPrincipal !== `dispatch:${params.dispatchId}` ||
      lease.runId !== params.runId ||
      lease.taskId !== params.taskId ||
      lease.attemptId !== params.attemptId ||
      !leaseTerminalIdentity ||
      !matchesTerminalIdentity(leaseTerminalIdentity, params)
    ) {
      throw conflict('The initial transcript segment does not match its terminal lease.')
    }
  }

  private findLatestIncarnationSegment(
    identity: DispatchTranscriptTerminalIdentity
  ): DispatchTranscriptSegment | undefined {
    const row = this.orchestrationDb.db
      .prepare(
        `SELECT * FROM dispatch_transcript_segments
         WHERE execution_host_id = ? AND workspace_key = ? AND terminal_handle = ?
           AND pty_incarnation = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(
        identity.executionHostId,
        identity.workspaceKey,
        identity.terminalHandle,
        identity.ptyIncarnation
      ) as DispatchTranscriptSegmentRow | undefined
    return row ? deserializeDispatchTranscriptSegment(row) : undefined
  }
}

function conflict(message: string): OrchestrationError {
  return new OrchestrationError('lease_identity_conflict', message)
}
