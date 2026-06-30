import { scryModelSchema } from '../schemas'
import type { ScryerOperationExecutor } from '../types'
import { failure, success } from './helpers'
import {
  cloneModel,
  fieldErrorsFromZod,
  hasUnrecognizedKeys,
  type RecordInput
} from './structural-input'

function parseModel(data: unknown) {
  const result = scryModelSchema.safeParse(data)
  if (result.success) {
    return { ok: true as const, model: result.data }
  }
  const fieldErrors = fieldErrorsFromZod(result.error)
  return {
    ok: false as const,
    reason: hasUnrecognizedKeys(result.error) ? 'unknown_fields' : 'invalid_schema',
    fieldErrors
  }
}

export const modelSetOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({ input }) => {
  const parsed = parseModel(input.data)
  if (!parsed.ok) {
    return failure(
      'incompatible_model',
      'Scryer model.set data failed schema validation',
      {
        path: 'input.data',
        expectedVersion: '0.3',
        reason: parsed.reason,
        fields: parsed.fieldErrors.map((error) => error.path.replace(/^input\./, ''))
      },
      {
        fieldErrors: parsed.fieldErrors.map((error) => ({
          ...error,
          path: `data.${error.path}`
        }))
      }
    )
  }
  return success({
    result: {
      updatedCount: 1,
      nodeCount: parsed.model.nodes.length,
      linkCount: parsed.model.links.length,
      groupCount: parsed.model.groups.length
    },
    changes: {
      committed: parsed.model,
      planned: cloneModel(parsed.model),
      baseline: 'refresh'
    }
  })
}
