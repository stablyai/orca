import type {
  PipelineV2TemplatePublishInput,
  PipelineV2TemplateDisableInput,
  PipelineV2TemplateReceipt
} from '../../shared/pipelines/v2/pipeline-v2-template-contracts'
import type {
  PipelineV2DecisionInput,
  PipelineV2BudgetInput,
  PipelineV2OwnerSynchronizeInput
} from '../../shared/pipelines/v2/pipeline-v2-owner-contracts'
import type {
  PipelineV2Receipt,
  PipelineV2InvocationReceipt
} from '../../shared/pipelines/v2/pipeline-v2-results'
import type {
  PipelineV2BoundSessionInput,
  PipelineV2BoundSessionResult
} from '../../shared/pipelines/v2/pipeline-v2-session-contracts'

export type PipelineOwnerApi = {
  publishTemplate: (input: PipelineV2TemplatePublishInput) => Promise<PipelineV2TemplateReceipt>
  disableTemplate: (input: PipelineV2TemplateDisableInput) => Promise<PipelineV2TemplateReceipt>
  resolveDecision: (input: PipelineV2DecisionInput) => Promise<PipelineV2Receipt>
  resolveBudget: (input: PipelineV2BudgetInput) => Promise<PipelineV2Receipt>
  discussBoundSession: (input: PipelineV2BoundSessionInput) => Promise<PipelineV2BoundSessionResult>
  synchronize: (input: PipelineV2OwnerSynchronizeInput) => Promise<PipelineV2InvocationReceipt>
}
