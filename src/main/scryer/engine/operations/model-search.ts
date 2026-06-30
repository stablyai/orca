import { selectModelSearch } from '../read-selector'
import type {
  ScryerModelSearchInput,
  ScryerModelSearchResult,
  ScryerOperationExecutor
} from '../types'
import { failure, success } from './operation-result'

export const modelSearchOperation: ScryerOperationExecutor<
  ScryerModelSearchInput,
  ScryerModelSearchResult
> = ({ input, state }) => {
  const layer = input.layer ?? 'plan'
  const model = layer === 'committed' ? state.committed : state.planned
  if (!model) {
    return failure('internal_error', `Declared ${layer} state was not loaded`, {
      reason: 'policy_violation',
      contractOperationId: 'scryer.model.search'
    })
  }
  const selected = selectModelSearch(model, input)
  if (!selected.ok) {
    return failure(
      selected.failure.code,
      selected.failure.message,
      selected.failure.details,
      selected.failure.fieldErrors ? { fieldErrors: selected.failure.fieldErrors } : {}
    )
  }
  return success({ result: selected.result })
}
