import type { AiVaultHandoffPackArgs, AiVaultHandoffPackResult } from '../../shared/ai-vault/contracts/ai-vault-types'
import { readAiVaultHandoffPack } from './session-handoff-pack-read'

export function handleAiVaultBuildHandoffPack(
  args?: AiVaultHandoffPackArgs
): Promise<AiVaultHandoffPackResult> {
  if (!args || typeof args.filePath !== 'string' || typeof args.agent !== 'string') {
    return Promise.resolve({ text: null })
  }
  return readAiVaultHandoffPack({
    agent: args.agent,
    filePath: args.filePath,
    executionHostId: args.executionHostId,
    ...(args.mode === 'summary' || args.mode === 'full' ? { mode: args.mode } : {}),
    ...(typeof args.maxMessages === 'number' ? { maxMessages: args.maxMessages } : {}),
    ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {})
  })
}
