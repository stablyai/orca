export const pipelineV2ContextPayloadLimit = 15488
export function assertPipelineV2ContextBudget(value: unknown): void {
  if (JSON.stringify(value).length > pipelineV2ContextPayloadLimit) {
    throw new Error('pipeline_context_budget')
  }
}
