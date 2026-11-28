import {
  isCodexProviderModelId,
  parseCodexModelId
} from '../../../../shared/agent-session/options/model-catalog/codex-provider-model'
import type { CodexStructuredLaunch } from '../session-lifecycle/codex-structured-session-state'

export function withCodexSubmittedThreadModel(
  launch: CodexStructuredLaunch,
  submittedModel: string | undefined
): CodexStructuredLaunch {
  const { model: savedModel, ...launchSettings } = launch
  // A sparse resume submission still belongs to the provider selected for the saved thread.
  const model =
    launch.resumeThreadId && savedModel && isCodexProviderModelId(savedModel)
      ? savedModel
      : submittedModel
  return { ...launchSettings, ...(model ? { model } : {}) }
}

/** A model override cannot change the provider of an open Codex thread. */
export function codexThreadModel(id: string, selectedModelProvider: string | undefined): string {
  const selection = parseCodexModelId(id)
  if (selection.provider !== selectedModelProvider) {
    throw new Error('Start a new Codex chat to use a different model provider')
  }
  return selection.model
}
