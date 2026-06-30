import type { ScryerModelReadInput, ScryerModelReadResult, ScryerOperationExecutor } from '../types'
import { failure, success } from './helpers'

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
  return success({
    result: { layer, model, ...(layer === 'committed' ? { baselineRefreshed: true } : {}) },
    changes: layer === 'committed' ? { baseline: 'refresh' } : undefined
  })
}
