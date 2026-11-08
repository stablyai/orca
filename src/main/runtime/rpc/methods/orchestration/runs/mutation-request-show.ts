import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult
} from '../../../../../../shared/orchestration/orchestration-mutation-request'
import { defineMethod } from '../../../core'
import { RequestShowParams } from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'
import { externalCoordinatorReceiptCallerFingerprints } from '../../../external-coordinator-invocation'

export const ORCHESTRATION_MUTATION_REQUEST_METHODS = [
  defineMethod({
    name: 'orchestration.requestShow',
    permission: 'workspace',
    params: RequestShowParams,
    // Read durable receipts without writing/mutating again; keep this recovery query outside ORCHESTRATION_MUTATION_METHODS.
    handler: (params, context): OrchestrationMutationRequestShowResult => {
      const { runtime, authenticatedCallerFingerprint, orchestrationCompatibilityEvidence } =
        context
      const db = runtime.getOrchestrationDb()
      // Receipt caller keys come from the paired fingerprint or the local mutation identity.
      const callerFingerprint =
        authenticatedCallerFingerprint ?? db.getOrCreateLocalMutationCallerFingerprint()
      // The request names no Run, so search every partition this external coordinator's mutations used.
      const row = [
        callerFingerprint,
        ...externalCoordinatorReceiptCallerFingerprints(
          runtime,
          orchestrationCompatibilityEvidence,
          context
        )
      ]
        .map((fingerprint) => db.getMutationReceipt(fingerprint, params.request))
        .find((receipt) => receipt !== undefined)
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
