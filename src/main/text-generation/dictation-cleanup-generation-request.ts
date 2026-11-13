import {
  buildDictationCleanupPrompt,
  sanitizeDictationCleanupOutput
} from '../../shared/dictation-cleanup'
import type { DictationTerm } from '../../shared/dictation-dictionary'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { VoiceSettings } from '../../shared/speech-types'
import { runGenerationRequest } from './agent-generation-request'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import type { CommitMessageGenerationTarget } from './source-control-text-generation-types'

export type GenerateDictationCleanupResult =
  | { success: true; text: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export async function generateDictationCleanup(input: {
  text: string
  voice: VoiceSettings | undefined
  terms: readonly DictationTerm[]
  params: ResolvedSourceControlAiGenerationParams
  target: CommitMessageGenerationTarget
}): Promise<GenerateDictationCleanupResult> {
  const basePrompt = buildDictationCleanupPrompt(input)
  const result = await runGenerationRequest({
    params: input.params,
    prompt: renderSourceControlActionCommandTemplate(
      input.params.commandInputTemplate ?? '{basePrompt}',
      { basePrompt }
    ),
    target: input.target,
    operation: 'dictation-cleanup',
    spawnAgent: spawnSourceControlAgent
  })
  if (!result.success) {
    return { success: false, error: result.error, canceled: result.canceled }
  }
  const text = sanitizeDictationCleanupOutput(result.rawOutput)
  return text
    ? { success: true, text, agentLabel: result.agentLabel }
    : { success: false, error: `${result.agentLabel ?? input.params.agentId} returned no text.` }
}
