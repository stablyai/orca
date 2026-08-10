import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  createRolloutSessionResumeState,
  parseRolloutSessionContent,
  parseRolloutSessionFile
} from './session-scanner-rollout-parser'
import type { FileWithMtime, ResumableSessionParseState } from './session-scanner-types'

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codexHome: string | null = null,
  executionHostId?: ExecutionHostId
): Promise<AiVaultSession | null> {
  return parseRolloutSessionFile({
    agent: 'codex',
    file,
    platform,
    sessionHome: codexHome,
    executionHostId
  })
}

export async function parseCodexSessionContent(args: {
  file: FileWithMtime
  content: string
  platform?: NodeJS.Platform
  codexHome?: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  return parseRolloutSessionContent({
    agent: 'codex',
    file: args.file,
    content: args.content,
    platform: args.platform ?? process.platform,
    sessionHome: args.codexHome ?? null,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform,
    readIndexedTitle: args.readIndexedTitle,
    signal: args.signal
  })
}

export function createCodexSessionResumeState(
  file: FileWithMtime,
  codexHome: string | null
): ResumableSessionParseState {
  return createRolloutSessionResumeState({ agent: 'codex', file, sessionHome: codexHome })
}
