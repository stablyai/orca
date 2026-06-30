import type {
  ScryerModelValidateInput,
  ScryerModelValidateResult,
  ScryerOperationExecutor
} from '../types'
import { failure, success } from './helpers'

export const modelValidateOperation: ScryerOperationExecutor<
  ScryerModelValidateInput,
  ScryerModelValidateResult
> = ({ state, services }) => {
  if (!state.committed) {
    return failure('internal_error', 'Committed state was not loaded for validation', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.model.validate'
    })
  }
  const findings = services.validators.validateModel(state.committed)
  return success({
    result: {
      findings,
      validationWarningCount: findings.filter((item) => item.severity === 'warning').length,
      validationErrorCount: findings.filter((item) => item.severity === 'error').length
    }
  })
}
