import type { z } from 'zod'
import { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2DraftOperation } from '../../../../shared/rpc-contract/pipeline-v2-params'

export function editPipelineV2Draft(
  template: PipelineV2Template,
  operations: z.infer<typeof PipelineV2DraftOperation>[]
): PipelineV2Template {
  const draft = structuredClone(template)
  for (const operation of operations) {
    const ids = draft.stages.map((stage) => stage.id)
    if (new Set(ids).size !== ids.length) {
      throw new Error('pipeline_duplicate_stage')
    }
    switch (operation.kind) {
      case 'insert': {
        if (ids.includes(operation.stage.id)) {
          throw new Error('pipeline_duplicate_stage')
        }
        const index = operation.afterStageId ? ids.indexOf(operation.afterStageId) : -1
        if (operation.afterStageId && index < 0) {
          throw new Error('pipeline_invalid_stage')
        }
        draft.stages.splice(index + 1, 0, structuredClone(operation.stage))
        break
      }
      case 'update': {
        const index = ids.indexOf(operation.stage.id)
        if (index === -1) {
          throw new Error('pipeline_invalid_stage')
        }
        draft.stages[index] = structuredClone(operation.stage)
        break
      }
      case 'delete': {
        const index = ids.indexOf(operation.stageId)
        if (index === -1) {
          throw new Error('pipeline_invalid_stage')
        }
        draft.stages.splice(index, 1)
        break
      }
      case 'reorder':
        if (
          operation.stageIds.length !== ids.length ||
          new Set(operation.stageIds).size !== ids.length ||
          operation.stageIds.some((id) => !ids.includes(id))
        ) {
          throw new Error('pipeline_invalid_stage_order')
        }
        draft.stages = operation.stageIds.map((id) =>
          draft.stages.find((stage) => stage.id === id)!
        )
        break
      case 'template': {
        const { kind: _kind, ...patch } = operation
        Object.assign(draft, patch)
        break
      }
    }
  }
  return PipelineV2Template.parse(draft)
}
