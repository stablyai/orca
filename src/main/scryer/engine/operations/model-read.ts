import type { ScryerModelReadInput, ScryerModelReadResult, ScryerOperationExecutor } from '../types'
import { selectModelRead } from '../read-selector'
import { failure, success } from './operation-result'

export const modelReadOperation: ScryerOperationExecutor<
  ScryerModelReadInput,
  ScryerModelReadResult
> = ({ input, state }) => {
  const layer = input.layer ?? 'plan'
  const model = layer === 'committed' ? state.committed : state.planned
  if (!model) {
    return failure('internal_error', `Declared ${layer} state was not loaded`, {
      reason: 'policy_violation',
      contractOperationId: 'scryer.model.read'
    })
  }
  const selected = selectModelRead(model, input)
  if (!selected.ok) {
    return failure(
      selected.failure.code,
      selected.failure.message,
      selected.failure.details,
      selected.failure.fieldErrors ? { fieldErrors: selected.failure.fieldErrors } : {}
    )
  }
  const result: ScryerModelReadResult =
    layer === 'committed' ? { ...selected.result, baselineRefreshed: true } : selected.result
  return success({
    result,
    changes: layer === 'committed' ? { baseline: 'refresh' } : undefined
  })
}
