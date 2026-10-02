import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import type { AgentType } from '../../shared/native-chat-types'
import type { ReadTranscriptResult } from '../native-chat/transcript-reader'
import { readNativeChatSessionContext } from '../native-chat/session-context-reader'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-watch'

export const DESKTOP_NATIVE_CHAT_READ_WINDOW = 300

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  limit?: number
  transcriptPath?: string
  paneKey?: string
}

export async function readNativeChatSession(
  args: NativeChatReadSessionArgs
): Promise<ReadTranscriptResult & { context?: AgentSessionContextSnapshot }> {
  const limit =
    args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_NATIVE_CHAT_READ_WINDOW
  const [result, context] = await Promise.all([
    readNativeChatTranscriptTail({
      agent: args.agent,
      sessionId: args.sessionId,
      transcriptPath: args.transcriptPath,
      limit
    }),
    readNativeChatSessionContext(args)
  ])
  return 'messages' in result
    ? { ...result, ...(context.source === 'unavailable' ? {} : { context }) }
    : result
}
