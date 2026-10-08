import {
  buildConversationNamePrompt,
  clampConversationNameFirstPrompt,
  sanitizeGeneratedConversationName,
  type ConversationNameContext
} from '../../shared/conversation-name-generation'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control-ai-actions'
import { captureAgentGenerationFailureOutput } from './agent-failure-output'
import {
  commandBackslashMode,
  executeGenerationPlan
} from './source-control-text-generation-requests'
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
}): Promise<GenerateConversationNameResult> {
  const { context, params, target } = input
  const firstPrompt = clampConversationNameFirstPrompt(context.firstPrompt)
  const basePrompt = buildConversationNamePrompt({ firstPrompt })
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
          basePrompt,
          firstPrompt
        })
      : buildConversationNamePrompt({ firstPrompt }, params.customPrompt ?? '')
  const planned = planCommitMessageGeneration(
    { ...params, backslash: commandBackslashMode(target) },
    prompt
  )
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }

  const result = await executeGenerationPlan({
    ...input,
    plan: planned.plan,
    emptyResultName: 'chat name',
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
          captureAgentGenerationFailureOutput(planned.plan.label, 0, result.rawOutput, '') ??
          undefined
      }
}
