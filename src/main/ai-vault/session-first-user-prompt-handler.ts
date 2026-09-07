import type {
  AiVaultFirstUserPromptArgs,
  AiVaultFirstUserPromptResult
} from '../../shared/ai-vault-types'
import { readAiVaultFirstUserPromptInBackground } from './session-scanner-background'

export function handleAiVaultGetFirstUserPrompt(
  args?: AiVaultFirstUserPromptArgs
): Promise<AiVaultFirstUserPromptResult> {
  if (!args || typeof args.filePath !== 'string' || typeof args.agent !== 'string') {
    return Promise.resolve({ prompt: null })
  }
  return readAiVaultFirstUserPromptInBackground({
    agent: args.agent,
    filePath: args.filePath,
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
    executionHostId: args.executionHostId,
    codexHome: args.codexHome
  })
}
