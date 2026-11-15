import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { decodeClaudeTurnLifecycle, decodeCodexTurnLifecycle } from './transcript-turn-lifecycle'

export type NativeChatTurnEvidence = {
  state: 'working' | 'completed'
  replyIndex?: number
}

/** Observes only lines the tail reader already visits, newest first. Completion needs both
 *  boundaries and a retained text reply between them; continuation after an end invalidates it. */
export function nativeChatTurnEvidenceObserverForAgent(agent: AgentType) {
  const provider = resolveNativeChatTranscriptAgent(agent)
  if (provider !== 'claude' && provider !== 'codex') {
    return null
  }
  let newest: NativeChatTurnLifecycle | undefined
  let endOffset: number | undefined
  let replyOffset: number | undefined
  let started = false
  let activityAfterEnd = false
  let foundReply = false
  let invalid = false
  return {
    observe(line: string, fallbackId: string, offset: number, message: NativeChatMessage | null) {
      if (started || invalid || (newest && newest.state !== 'completed')) {
        return
      }
      const record = parseJsonObject(line)
      const marker =
        provider === 'codex'
          ? decodeCodexTurnLifecycle(line, fallbackId)
          : decodeClaudeTurnLifecycle(line, fallbackId)
      if (!newest && marker) {
        newest = marker
        if (marker.state !== 'completed') {
          return
        }
        endOffset = offset
        const reason = asRecord(record?.message)?.stop_reason
        if (
          activityAfterEnd ||
          (provider === 'claude' &&
            !['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(String(reason)))
        ) {
          invalid = true
          return
        }
      } else if (newest && marker?.state === 'working') {
        started = provider === 'claude' || marker.turnId === newest.turnId
        invalid = !started
        return
      } else if (newest && provider === 'codex' && marker) {
        invalid = true
        return
      }
      const activity =
        !!message ||
        record?.type === 'user' ||
        record?.type === 'assistant' ||
        record?.type === 'response_item'
      if (!newest) {
        activityAfterEnd ||= activity
        return
      }
      if (!foundReply && activity) {
        foundReply = true
        const text = message?.blocks.some(
          (block) => block.type === 'text' && block.text.trim().length > 0
        )
        if (
          message?.role === 'assistant' &&
          text &&
          !message.blocks.some((block) => block.type === 'tool-call') &&
          (provider !== 'claude' || offset === endOffset)
        ) {
          replyOffset = offset
        } else {
          invalid = true
        }
      }
    },
    result(offsets: readonly number[]): NativeChatTurnEvidence | undefined {
      if (!invalid && newest?.state === 'working') {
        return { state: 'working' }
      }
      const replyIndex = replyOffset === undefined ? -1 : offsets.indexOf(replyOffset)
      return !invalid &&
        started &&
        replyOffset !== undefined &&
        endOffset !== undefined &&
        replyOffset <= endOffset &&
        replyIndex >= 0
        ? { state: 'completed', replyIndex }
        : undefined
    }
  }
}
