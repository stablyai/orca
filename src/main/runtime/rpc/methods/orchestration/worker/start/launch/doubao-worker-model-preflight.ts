import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import { discoverDoubaoLaunchModels } from '../../../../../../terminal/launch/doubao-launch-model-discovery'

export async function assertDoubaoWorkerModel(
  runtime: OrcaRuntimeService,
  params: { agent?: string; model?: string; effort?: string },
  target: { repo: string } | { worktree: string }
): Promise<void> {
  if (params.agent !== 'doubao' || !params.model) {
    return
  }
  const result = await discoverDoubaoLaunchModels(runtime, target)
  if (!result.success) {
    throw new OrchestrationError('capability_unsupported', result.error)
  }
  const byId = result.models.find((model) => model.id === params.model)
  const matches = byId ? [byId] : result.models.filter((model) => model.label === params.model)
  if (matches.length !== 1) {
    throw new OrchestrationError(
      'invalid_argument',
      `Choose a Doubao model ID or unique name from doubao model list --json on the worker host; got ${params.model}.`
    )
  }
  const model = matches[0]
  if (params.effort && !model.thinkingLevels?.some((level) => level.id === params.effort)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Doubao model ${model.id} (${model.label}) does not support effort ${params.effort}.`
    )
  }
}
