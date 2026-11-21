import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { extractString } from '../../../shared/text/trimmed-string'
import { decodeClaudeTurnLifecycle, decodeCodexTurnLifecycle } from './transcript-turn-lifecycle'

export type NativeChatTurnEvidence = {
  state: 'working' | 'completed'
  replyIndex?: number
}

/** Observes only lines the tail reader already visits, newest first. Completion needs the newest
 *  end marker and its own turn's text reply: for Claude the end row itself, for Codex the newest
 *  decoded reply stamped with that turn or found before its start. Activity after an end voids it. */
export function nativeChatTurnEvidenceObserverForAgent(agent: AgentType) {
  const provider = resolveNativeChatTranscriptAgent(agent)
  if (provider !== 'claude' && provider !== 'codex') {
    return null
  }
  let newest: NativeChatTurnLifecycle | undefined
  let replyOffset: number | undefined
  let activityAfterEnd = false
  let proved = false
  let invalid = false
  return {
    observe(line: string, fallbackId: string, offset: number, message: NativeChatMessage | null) {
      if (proved || invalid || (newest && newest.state !== 'completed')) {
        return
      }
      const record = parseJsonObject(line)
      const marker =
        provider === 'codex'
          ? decodeCodexTurnLifecycle(line, fallbackId)
          : decodeClaudeTurnLifecycle(line, fallbackId)
      if (!newest) {
        if (!marker) {
          activityAfterEnd ||=
            !!message ||
            record?.type === 'user' ||
            record?.type === 'assistant' ||
            record?.type === 'response_item'
          return
        }
        newest = marker
        if (marker.state !== 'completed') {
          return
        }
        const reason = asRecord(record?.message)?.stop_reason
        if (
          activityAfterEnd ||
          (provider === 'claude' &&
            !['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(String(reason)))
        ) {
          invalid = true
        } else if (provider === 'claude') {
          proved = isTextReply(message)
          invalid = !proved
          replyOffset = offset
        }
        return
      }
      if (marker) {
        proved =
          marker.state === 'working' && marker.turnId === newest.turnId && replyOffset !== undefined
        invalid = !proved
        return
      }
      // Undecoded raw copies and tool output are not the reply; the newest prompt or reply is.
      if (
        replyOffset !== undefined ||
        (message?.role !== 'user' && message?.role !== 'assistant')
      ) {
        return
      }
      if (!isTextReply(message)) {
        invalid = true
        return
      }
      replyOffset = offset
      proved = extractString(asRecord(record?.payload)?.turn_id) === newest.turnId
    },
    result(offsets: readonly number[]): NativeChatTurnEvidence | undefined {
      if (!invalid && newest?.state === 'working') {
        return { state: 'working' }
      }
      const replyIndex = replyOffset === undefined ? -1 : offsets.indexOf(replyOffset)
      return proved && replyIndex >= 0 ? { state: 'completed', replyIndex } : undefined
    }
  }
}

function isTextReply(message: NativeChatMessage | null): boolean {
  return (
    message?.role === 'assistant' &&
    message.blocks.some((block) => block.type === 'text' && block.text.trim().length > 0) &&
    !message.blocks.some((block) => block.type === 'tool-call')
  )
}
