import { basename, dirname, join } from 'node:path'
import {
  requireLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { AgentConversationCopyError } from '../../native-chat/conversation-adoption/agent-conversation-copy-error'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { materializeClaudeConversationTranscript } from './claude-rewind-transcript'
import type { ClaudeForkCheckpoint } from './claude-conversation-fork-boundary'
import { encodeClaudeProjectPath } from '../../ai-vault/scanners/claude/claude-project-dir-encoding'

// Claude names a longer path's bucket with a hash Orca cannot reproduce.
const CLAUDE_PLAIN_BUCKET_NAME_MAX_LENGTH = 200

/** Claude resumes a chat only from its working folder's bucket, so a copy for another worktree goes there. */
export function claudeDestinationBucket(destinationCwd: string | undefined): string | null {
  if (destinationCwd === undefined) {
    return null
  }
  const bucket = encodeClaudeProjectPath(destinationCwd)
  if (bucket.length > CLAUDE_PLAIN_BUCKET_NAME_MAX_LENGTH) {
    throw new AgentConversationCopyError(
      'Claude cannot copy this chat into a worktree with such a long path. Use a shorter worktree path, then try again.'
    )
  }
  return bucket
}

/** The saved transcript a fork checkpoint names, searched in the chat's own account home first. */
export async function resolveClaudeForkSource(input: {
  checkpoint: ClaudeForkCheckpoint | undefined
  accountHome: AgentSessionAccountHome
  signal: AbortSignal
}): Promise<{
  sourcePath: string
  sourceSessionId: string
  checkpoint: ClaudeForkCheckpoint
} | null> {
  const { checkpoint, signal } = input
  const sourceSessionId =
    checkpoint?.beforeMessage?.sessionId ??
    checkpoint?.rootMessage?.sessionId ??
    checkpoint?.throughMessage?.sessionId
  if (!checkpoint || !sourceSessionId) {
    return null
  }
  const router = getClaudeProfileRouter()
  const homes = new Set([
    requireLegacyAgentSessionAccountHome(input.accountHome).path,
    ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : [])
  ])
  for (const home of homes) {
    signal.throwIfAborted()
    const sourcePath = await resolveSessionFilePath(
      'claude',
      sourceSessionId,
      { claudeProjectsDir: join(home, 'projects'), strictErrors: true },
      signal
    )
    if (sourcePath) {
      return { sourcePath, sourceSessionId, checkpoint }
    }
  }
  return null
}

export const copyClaudeConversation: NonNullable<
  StructuredAgentSessionAdapter['copyConversation']
> = async (input) => {
  const unavailable = () =>
    new AgentConversationCopyError(
      'Claude could not find the saved context for this response. Open the source chat and try again.'
    )
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : [])
  ])
  const destinationHome = requireLegacyAgentSessionAccountHome(input.accountHome).path
  const destinationBucket = claudeDestinationBucket(input.destinationCwd)
  const source = await resolveClaudeForkSource({
    checkpoint: input.checkpoint,
    accountHome: input.accountHome,
    signal
  })
  if (!source) {
    throw unavailable()
  }
  return (
    (await materializeClaudeConversationTranscript({
      ...source,
      destinationDirectory: join(
        destinationHome,
        'projects',
        destinationBucket ?? basename(dirname(source.sourcePath))
      ),
      title: input.title,
      signal
    })) ?? Promise.reject(unavailable())
  )
}
