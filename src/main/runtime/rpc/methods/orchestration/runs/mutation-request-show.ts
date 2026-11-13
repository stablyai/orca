import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult
} from '../../../../../../shared/orchestration/orchestration-mutation-request'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { RequestShowParams } from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'
import { expandCompactedMutationReceipt } from '../../../../orchestration/db/mutation-receipts/mutation-receipt-compaction'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { readReceiptMessage } from '../messaging/mailbox-message-receipt'

export const ORCHESTRATION_MUTATION_REQUEST_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.requestShow',
    access: { kind: 'reads', server: 'on', targets: { request: 'request' } },
    permission: 'workspace',
    params: RequestShowParams,
    // Read durable receipts without writing/mutating again; keep this recovery query outside ORCHESTRATION_MUTATION_METHODS.
    handler: (
      params,
      { runtime, authenticatedCallerFingerprint }
    ): OrchestrationMutationRequestShowResult => {
      const db = runtime.getOrchestrationDb()
      // Receipt caller keys come from the paired fingerprint or the local mutation identity.
      const callerFingerprint =
        authenticatedCallerFingerprint ?? db.getOrCreateLocalMutationCallerFingerprint()
      const row = db.getMutationReceipt(callerFingerprint, params.request)
      if (!row) {
        return {
          requestId: params.request,
          state: 'absent',
          interpretation: describeMutationRequestState({
            requestId: params.request,
            state: 'absent'
          })
        }
      }
      return {
        requestId: params.request,
        state: row.state,
        method: row.method,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.receipt ? { receipt: readReceipt(db, params.request, row.receipt) } : {}),
        interpretation: describeMutationRequestState({
          requestId: params.request,
          state: row.state,
          method: row.method
        })
      }
    }
  })
]

function readReceipt(db: OrchestrationDb, requestId: string, receipt: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(receipt)
  } catch {
    return undefined
  }
  try {
    return expandCompactedMutationReceipt(parsed, requestId, (messageId) =>
      readReceiptMessage(db, messageId)
    )
  } catch {
    return parsed
  }
}
