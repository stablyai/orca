import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult
} from '../../../../shared/orchestration-mutation-request'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { z } from 'zod'

const RequestShowParams = z.object({ request: requiredString('Missing --request') })

export const ORCHESTRATION_MUTATION_REQUEST_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.requestShow',
    params: RequestShowParams,
    // Why: recovery needs a way to ask whether a mutation landed without mutating
    // again; this reads the durable receipt and never writes one, so it must stay
    // out of ORCHESTRATION_MUTATION_METHODS.
    handler: (
      params,
      { runtime, authenticatedCallerFingerprint }
    ): OrchestrationMutationRequestShowResult => {
      const db = runtime.getOrchestrationDb()
      // Why: receipts are keyed by caller identity; a paired client brings its own
      // fingerprint, a local caller shares the one its mutations were recorded under.
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
