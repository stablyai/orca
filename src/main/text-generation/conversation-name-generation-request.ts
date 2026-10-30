import {
  renderConversationNamePrompt,
  sanitizeGeneratedConversationName,
  type ConversationNameContext
} from '../../shared/conversation-name-generation'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { captureAgentGenerationFailureOutput } from './agent-failure-output'
import { runGenerationRequest } from './agent-generation-request'
import type {
  CommitMessageGenerationTarget,
  GenerateConversationNameResult,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

export async function generateConversationName(input: {
  context: ConversationNameContext
  params: ResolvedSourceControlAiGenerationParams
  target: CommitMessageGenerationTarget
  spawnAgent: SpawnSourceControlAgent
  shouldExecute?: () => boolean
}): Promise<GenerateConversationNameResult> {
  const { context, params } = input
  const prompt = renderConversationNamePrompt(context, params)

  const result = await runGenerationRequest({
    ...input,
    prompt,
    operation: 'conversation-name'
  })
  if (!result.success) {
    return result
  }

  const name = sanitizeGeneratedConversationName(result.rawOutput)
  return name
    ? { success: true, name, agentLabel: result.agentLabel }
    : {
        success: false,
        error: 'Generated chat name was empty after sanitization.',
        failureOutput:
          captureAgentGenerationFailureOutput(
            result.agentLabel ?? params.agentId,
            0,
            result.rawOutput,
            ''
          ) ?? undefined
      }
}
