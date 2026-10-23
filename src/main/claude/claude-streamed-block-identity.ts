import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

// Stream and final frames have different UUIDs; reconcile by message.id and block order to avoid duplicate rows.

export type ClaudeStreamedTextDelta = {
  identity: AgentJournalItemIdentity
  text: string
  /** Carry producer scope with deltas because checkpoint writes have no envelope. */
  parentToolUseId: string | null
  /** Host time of block start, or first delta if absent; text may arrive seconds later. */
  startedAt: number
}

export type StreamedBlock = { identity: AgentJournalItemIdentity; startedAt: number }

type StreamedMessage = {
  messageId: string | null
  blocks: Map<number, StreamedBlock>
  /** Await final frames in block order for both text and thinking. */
  awaitingFinal: StreamedBlock[]
}

export type ClaudeStreamedBlockRegistry = {
  observe: (frame: Record<string, unknown>, observedAt: number) => ClaudeStreamedTextDelta | null
  reconcile: (frame: {
    sessionId: string
    parentToolUseId: string | null
    messageId: string | null
  }) => StreamedBlock | null
  clear: () => void
}

function scopeKey(sessionId: string, parentToolUseId: string | null): string {
  return `${sessionId}/${parentToolUseId ?? ''}`
}

export function createClaudeStreamedBlockRegistry(
  blockType: 'text' | 'thinking' = 'text'
): ClaudeStreamedBlockRegistry {
  const messages = new Map<string, StreamedMessage>()

  const messageFor = (scope: string): StreamedMessage => {
    let streamed = messages.get(scope)
    if (!streamed) {
      streamed = { messageId: null, blocks: new Map(), awaitingFinal: [] }
      messages.set(scope, streamed)
    }
    return streamed
  }

  const mint = (
    streamed: StreamedMessage,
    sessionId: string,
    index: number,
    uuid: string,
    startedAt: number
  ): StreamedBlock => {
    const identity: AgentJournalItemIdentity = { provider: 'claude', sessionId, uuid }
    const block = { identity, startedAt }
    streamed.blocks.set(index, block)
    streamed.awaitingFinal.push(block)
    return block
  }

  return {
    observe: (frame, observedAt) => {
      const event = claudeRecord(frame.event)
      const sessionId = claudeText(frame.session_id)
      const uuid = claudeText(frame.uuid)
      if (frame.type !== 'stream_event' || !event || !sessionId || !uuid) {
        return null
      }
      const parentToolUseId = claudeText(frame.parent_tool_use_id)
      const scope = scopeKey(sessionId, parentToolUseId)
      if (event.type === 'message_start') {
        messages.set(scope, {
          messageId: claudeText(claudeRecord(event.message)?.id),
          blocks: new Map(),
          awaitingFinal: []
        })
        return null
      }
      const index = typeof event.index === 'number' ? event.index : 0
      if (event.type === 'content_block_start') {
        const block = claudeRecord(event.content_block)
        if (block?.type !== blockType) {
          return null
        }
        const started = mint(messageFor(scope), sessionId, index, uuid, observedAt)
        const text = claudeText(block[blockType])
        return text ? { ...started, text, parentToolUseId } : null
      }
      if (event.type !== 'content_block_delta') {
        return null
      }
      const delta = claudeRecord(event.delta)
      const text = delta?.type === `${blockType}_delta` ? claudeText(delta[blockType]) : null
      if (!text) {
        return null
      }
      const streamed = messageFor(scope)
      const started =
        streamed.blocks.get(index) ?? mint(streamed, sessionId, index, uuid, observedAt)
      return { ...started, text, parentToolUseId }
    },
    reconcile: (frame) => {
      const streamed = messages.get(scopeKey(frame.sessionId, frame.parentToolUseId))
      if (
        !streamed ||
        (frame.messageId && streamed.messageId && frame.messageId !== streamed.messageId)
      ) {
        return null
      }
      return streamed.awaitingFinal.shift() ?? null
    },
    clear: () => messages.clear()
  }
}
