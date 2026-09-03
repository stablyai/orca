import { buildOrchestrationPromptMarker } from '../../shared/orchestration-prompt-marker'

export type OrchestrationPromptEvidenceInput = {
  taskId: string
  dispatchId: string
  expectedProcessIncarnation: string
  currentProcessIncarnation: string | null
  submittedAt: number
  terminalOutputAt: number | null
  terminalStatus: string | null
  waitText: string
  hooks: readonly { prompt: string; state: string; receivedAt: number }[]
}

export function resolveOrchestrationPromptDeliveryEvidence(
  input: OrchestrationPromptEvidenceInput
): 'input_delivered' | 'worker_running' | null {
  if (input.currentProcessIncarnation !== input.expectedProcessIncarnation) {
    return null
  }
  const marker = buildOrchestrationPromptMarker(input.taskId, input.dispatchId)
  const exactHook = input.hooks.find(
    (hook) => hook.receivedAt >= input.submittedAt && hook.prompt.includes(marker)
  )
  if (exactHook?.state === 'working') {
    return 'worker_running'
  }
  return input.terminalOutputAt !== null &&
    input.terminalOutputAt >= input.submittedAt &&
    input.terminalStatus === 'working' &&
    input.waitText.includes(marker)
    ? 'input_delivered'
    : null
}
