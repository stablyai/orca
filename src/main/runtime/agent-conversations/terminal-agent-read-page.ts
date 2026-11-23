import {
  AGENT_CONVERSATION_REFUSAL_CODES as CODES,
  type AgentReadEntry
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import type {
  AgentStatusState,
  AgentType
} from '../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnEvidence } from '../../native-chat/transcript-decoding/transcript-turn-evidence'
import { readWorkerTranscript } from '../orchestration/workers/transcripts/worker-transcript-read'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import {
  decodeTerminalAgentReadCursor,
  encodeTerminalAgentReadCursor,
  staleAgentReadCursor
} from './agent-read-cursor'

export type TerminalAgentReadPage = {
  entries: AgentReadEntry[]
  limited: boolean
  nextCursor: string | null
  state?: AgentStatusState
}

/** One page of a terminal agent's transcript: the newest messages, or with `cursor` the next
 *  older ones. Messages the response bound drops stay for the next page, so pages followed to a
 *  null cursor hold every message once. */
export async function readTerminalAgentPage(args: {
  orcaSessionId: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  wslDistro?: string
  limit: number
  cursor?: string
}): Promise<TerminalAgentReadPage> {
  const { orcaSessionId } = args
  const position =
    args.cursor === undefined ? null : decodeTerminalAgentReadCursor(args.cursor, orcaSessionId)
  const transcript = await readWorkerTranscript({
    agent: args.agent,
    sessionId: args.sessionId,
    transcriptPath: args.transcriptPath,
    ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
    limit: args.limit,
    backward: position ? { endingAt: position } : {},
    ...(position ? { expectedSourceFingerprint: position.sourceFingerprint } : {})
  })
  if (!transcript.ok) {
    if (position && transcript.reason === 'source_changed') {
      throw staleAgentReadCursor(orcaSessionId)
    }
    throw new AgentConversationRefusal(
      CODES.noTranscript,
      `Orca couldn't read agent ${orcaSessionId}'s transcript (${transcript.reason.replaceAll('_', ' ')}).`
    )
  }
  const shortened = new Set(transcript.shortened ?? [])
  const entries = transcript.messages.flatMap((message, index): AgentReadEntry[] => {
    const entry = transcriptEntry(message)
    return entry ? [shortened.has(index) ? { ...entry, shortened: true } : entry] : []
  })
  const state = position
    ? undefined
    : transcriptTurnState(transcript.turn, transcript.messages, entries)
  const older = transcript.older ?? null
  return {
    entries,
    limited: transcript.limited,
    nextCursor: older
      ? encodeTerminalAgentReadCursor(orcaSessionId, {
          ...older,
          sourceFingerprint: transcript.sourceFingerprint
        })
      : null,
    ...(state ? { state } : {})
  }
}

/** The newest turn marker in the bytes read: a prompt with no end after it is `working`; `done`
 *  needs an explicit end whose reply is the newest entry here. Anything else is unknown. */
function transcriptTurnState(
  turn: NativeChatTurnEvidence | undefined,
  messages: readonly NativeChatMessage[],
  entries: readonly AgentReadEntry[]
): AgentStatusState | undefined {
  if (turn?.state === 'working') {
    return 'working'
  }
  const reply = entries.at(-1)
  const newest = messages.findLastIndex((message) => transcriptEntry(message) !== null)
  return turn?.state === 'completed' &&
    turn.replyIndex === newest &&
    reply?.kind === 'message' &&
    reply.role === 'assistant' &&
    reply.text.trim().length > 0
    ? 'done'
    : undefined
}

/** A transcript message's one entry, its tool calls folded in, so `limit` messages are at most
 *  `limit` entries. */
function transcriptEntry(message: NativeChatMessage): AgentReadEntry | null {
  if (message.role === 'reasoning' || message.role === 'tool') {
    return null
  }
  const text = message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n')
    .trim()
  const tools = message.blocks.flatMap((block) =>
    block.type === 'tool-call'
      ? [{ name: block.name, ...(block.state ? { state: block.state } : {}) }]
      : []
  )
  return text.length > 0 || tools.length > 0
    ? { kind: 'message', role: message.role, text, ...(tools.length > 0 ? { tools } : {}) }
    : null
}
