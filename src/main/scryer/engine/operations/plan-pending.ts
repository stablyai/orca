import type {
  ScryerOperationExecutor,
  ScryerPlanPendingInput,
  ScryerPlanPendingResult
} from '../types'
import { diffModels, summarizePending } from '../diff'
import { failure, success } from './operation-result'

export const planPendingOperation: ScryerOperationExecutor<
  ScryerPlanPendingInput,
  ScryerPlanPendingResult
> = ({ state }) => {
  if (!state.committed || !state.planned) {
    return failure(
      'internal_error',
      'Committed and planned state were not loaded for plan.pending',
      {
        reason: 'policy_violation',
        contractOperationId: 'scryer.plan.pending'
      }
    )
  }
  const changes = diffModels(state.committed, state.planned)
  return success({
    result: {
      clean: changes.length === 0,
      changes,
      summary: summarizePending(changes)
    }
  })
}
