import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat/native-chat-agent-support'
import type { ResolveSessionFileOptions } from './session-file-resolver'
import { canReadHermesTranscriptHere, hermesTranscriptDeps } from './transcript-hermes'
import {
  readOpenCodeNativeChatTranscriptTail,
  type OpenCodeTailResult
} from './transcript-history/opencode/transcript-opencode'

/** Hermes and OpenCode share one sqlite transcript. Other agents keep the line-file reader. */
export async function readSharedStoreTranscriptTail(
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    limit: number
    beforeOffset?: number
  },
  signal?: AbortSignal
): Promise<OpenCodeTailResult | null> {
  if (args.agent !== 'hermes' && resolveNativeChatTranscriptAgent(args.agent) !== 'opencode') {
    return null
  }
  if (args.agent === 'hermes' && !canReadHermesTranscriptHere(args)) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  return readOpenCodeNativeChatTranscriptTail(
    { ...args, agent: args.agent === 'zcode' ? 'zcode' : undefined },
    args.agent === 'hermes' ? hermesTranscriptDeps : {},
    signal
  )
}
