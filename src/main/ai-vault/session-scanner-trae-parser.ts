import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  createRolloutSessionResumeState,
  parseRolloutSessionContent,
  parseRolloutSessionFile
} from './session-scanner-rollout-parser'
import type { FileWithMtime, ResumableSessionParseState } from './session-scanner-types'

export function parseTraeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  executionHostId?: ExecutionHostId
): Promise<AiVaultSession | null> {
  return parseRolloutSessionFile({
    agent: 'trae',
    file,
    platform,
    sessionHome: null,
    executionHostId
  })
}

export function parseTraeSessionContent(args: {
  file: FileWithMtime
  content: string
  platform?: NodeJS.Platform
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  return parseRolloutSessionContent({
    agent: 'trae',
    file: args.file,
    content: args.content,
    platform: args.platform ?? process.platform,
    sessionHome: null,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform,
    readIndexedTitle: args.readIndexedTitle,
    signal: args.signal
  })
}

export function createTraeSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return createRolloutSessionResumeState({ agent: 'trae', file, sessionHome: null })
}
