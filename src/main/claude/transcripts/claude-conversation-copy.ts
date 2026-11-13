import { basename, dirname, join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { AgentConversationCopyError } from '../../native-chat/conversation-adoption/agent-conversation-copy-error'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { materializeClaudeConversationTranscript } from './claude-rewind-transcript'

export const copyClaudeConversation: NonNullable<
  StructuredAgentSessionAdapter['copyConversation']
> = async (input) => {
  const checkpoint = input.checkpoint
  const sourceSessionId =
    checkpoint?.beforeMessage?.sessionId ??
    checkpoint?.rootMessage?.sessionId ??
    checkpoint?.throughMessage?.sessionId
  const unavailable = () =>
    new AgentConversationCopyError(
      'Claude could not find the saved context for this response. Open the source chat and try again.'
    )
  if (!checkpoint || !sourceSessionId) {
    throw unavailable()
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : [])
  ])
  const destinationHome = requireLegacyAgentSessionAccountHome(input.accountHome).path
  const router = getClaudeProfileRouter()
  const homes = new Set([
    destinationHome,
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
    if (!sourcePath) {
      continue
    }
    return (
      (await materializeClaudeConversationTranscript({
        sourcePath,
        sourceSessionId,
        checkpoint,
        destinationDirectory: join(destinationHome, 'projects', basename(dirname(sourcePath))),
        title: input.title,
        signal
      })) ?? Promise.reject(unavailable())
    )
  }
  throw unavailable()
}
