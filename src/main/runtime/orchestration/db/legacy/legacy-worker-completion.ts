import type {
  MessageRow,
  LegacyCompatibilityPrincipalRow,
  LegacyPrincipalRole,
  LegacyOperationReceiptRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { exposeMessageTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

export function findLegacyWorkerCompletion(
  this: OrchestrationDb,
  params: {
    principalId: string
    taskId: string
    recipientHandle: string
    subject: string
    body: string
    payload: string | null
  }
): MessageRow | undefined {
  const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
  if (!principal || principal.role !== 'worker' || !principal.dispatch_id) {
    throw new OrchestrationError('request_mismatch', 'Legacy worker principal was not found.')
  }
  const runAddress = `run:${principal.run_id}`
  const rows = this.db
    .prepare(
      `SELECT * FROM messages
       WHERE run_id = ?
         AND (
           (delivery_contract = 'legacy_direct' AND to_handle = ?) OR
           (delivery_contract = 'current_delivery' AND to_handle = ?)
         )
         AND from_handle = ? AND type = 'worker_done'
         AND subject = ? AND body = ? AND payload IS ?
       ORDER BY sequence`
    )
    .all(
      principal.run_id,
      params.recipientHandle,
      runAddress,
      principal.terminal_handle,
      params.subject,
      params.body,
      params.payload
    ) as MessageRow[]
  const matches = rows.filter((message) => {
    try {
      const payload = JSON.parse(message.payload ?? '{}') as {
        taskId?: unknown
        dispatchId?: unknown
      }
      return payload.taskId === params.taskId && payload.dispatchId === principal.dispatch_id
    } catch {
      return false
    }
  })
  if (matches.length > 1) {
    throw new OrchestrationError(
      'operation_unknown',
      'Multiple matching legacy worker completions exist.'
    )
  }
  return matches[0] ? exposeMessageTimestamps(matches[0]) : undefined
}

export function hasPendingCurrentDelivery(this: OrchestrationDb, runId: string): boolean {
  return Boolean(
    this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE run_id = ? AND to_handle = ?
           AND delivery_contract = 'current_delivery' AND read = 0
         LIMIT 1`
      )
      .get(runId, `run:${runId}`)
  )
}

export function setLegacyCompatibilityPrincipalStatus(
  this: OrchestrationDb,
  id: string,
  status: 'settled' | 'revoked'
): LegacyCompatibilityPrincipalRow | undefined {
  this.db
    .prepare(
      `UPDATE legacy_compatibility_principals
       SET status = ?
       WHERE id = ? AND status = 'committed'`
    )
    .run(status, id)
  return this.getLegacyCompatibilityPrincipal(id)
}

export function getLegacyOperationReceipt(
  this: OrchestrationDb,
  principalId: string,
  operationKey: string
): LegacyOperationReceiptRow | undefined {
  return this.db
    .prepare(
      `SELECT * FROM legacy_operation_receipts
       WHERE principal_id = ? AND operation_key = ?`
    )
    .get(principalId, operationKey) as LegacyOperationReceiptRow | undefined
}

export function requireCommittedLegacyPrincipal(
  this: OrchestrationDb,
  principalId: string,
  role?: LegacyPrincipalRole
): LegacyCompatibilityPrincipalRow {
  const principal = this.getLegacyCompatibilityPrincipal(principalId)
  if (!principal || principal.status !== 'committed' || (role && principal.role !== role)) {
    throw new OrchestrationError(
      'request_mismatch',
      `Legacy compatibility principal ${principalId} is not committed for this operation.`
    )
  }
  return principal
}

export function requireLegacyMailPrincipal(
  this: OrchestrationDb,
  principalId: string,
  role?: LegacyPrincipalRole
): LegacyCompatibilityPrincipalRow {
  const principal = this.getLegacyCompatibilityPrincipal(principalId)
  if (
    !principal ||
    !['committed', 'settled'].includes(principal.status) ||
    (role && principal.role !== role)
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Legacy compatibility principal ${principalId} cannot access retained mail.`
    )
  }
  return principal
}

export type LegacyWorkerCompletionMethods = {
  findLegacyWorkerCompletion: typeof findLegacyWorkerCompletion
  hasPendingCurrentDelivery: typeof hasPendingCurrentDelivery
  setLegacyCompatibilityPrincipalStatus: typeof setLegacyCompatibilityPrincipalStatus
  getLegacyOperationReceipt: typeof getLegacyOperationReceipt
  requireCommittedLegacyPrincipal: typeof requireCommittedLegacyPrincipal
  requireLegacyMailPrincipal: typeof requireLegacyMailPrincipal
}

export function attachLegacyWorkerCompletion(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    findLegacyWorkerCompletion,
    hasPendingCurrentDelivery,
    setLegacyCompatibilityPrincipalStatus,
    getLegacyOperationReceipt,
    requireCommittedLegacyPrincipal,
    requireLegacyMailPrincipal
  })
}
