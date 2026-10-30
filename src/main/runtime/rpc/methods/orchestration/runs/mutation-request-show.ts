import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult
} from '../../../../../../shared/orchestration-mutation-request'
import { defineMethod } from '../../../core'
import { RequestShowParams } from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'

export const ORCHESTRATION_MUTATION_REQUEST_METHODS = [
  defineMethod({
    name: 'orchestration.requestShow',
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
        ...(row.receipt ? { receipt: parseReceipt(row.receipt) } : {}),
        interpretation: describeMutationRequestState({
          requestId: params.request,
          state: row.state,
          method: row.method
        })
      }
    }
  })
]

function parseReceipt(receipt: string): unknown {
  try {
    return JSON.parse(receipt)
  } catch {
    return undefined
  }
}
