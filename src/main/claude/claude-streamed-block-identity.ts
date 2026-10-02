import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

// Under --include-partial-messages every stream_event frame carries its own
// uuid, and the block's final `assistant` frame carries yet another; only
// `message.id` ties them together. The block's first stream frame mints the
// journal identity, and the final frame lands on it in block order instead of
// appending a duplicate under its own uuid.

export type ClaudeStreamedTextDelta = {
  identity: AgentJournalItemIdentity
  text: string
  /** The block's own scope, which this registry already keys its map on. Streamed
   *  prose has no message envelope when it is persisted, so the producer travels
   *  with the delta rather than being re-read from a frame that is long gone. */
  parentToolUseId: string | null
  /** Host clock when the block began: its `content_block_start`, else its first delta. Text can
   *  trail the start by seconds, so this, not the first write, is when the block started. */
  startedAt: number
}

export type StreamedBlock = { identity: AgentJournalItemIdentity; startedAt: number }

/** A block of the registry's type starting (blank included), growing, or stopping. A delta's text is
 *  never empty; a start's is whatever its `content_block_start` carried. */
export type ClaudeStreamedBlockEvent = Omit<ClaudeStreamedTextDelta, 'text'> &
  ({ kind: 'start' | 'delta'; text: string } | { kind: 'stop' })

type StreamedMessage = {
  messageId: string | null
  blocks: Map<number, StreamedBlock>
  /** Streamed text blocks whose final assistant frame has not arrived, in block order. */
  awaitingFinal: StreamedBlock[]
}

export type ClaudeStreamedBlockRegistry = {
  /** Text a stream_event frame appends to its block, or null when it carries none. */
  observe: (frame: Record<string, unknown>, observedAt: number) => ClaudeStreamedTextDelta | null
  /** What a stream_event frame did to a block of this type, or null when it touched none. */
  observeBlock: (
    frame: Record<string, unknown>,
    observedAt: number
  ) => ClaudeStreamedBlockEvent | null
  /** The streamed block a final assistant frame reconciles onto, if its block streamed. */
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

  const observeBlock = (
    frame: Record<string, unknown>,
    observedAt: number
  ): ClaudeStreamedBlockEvent | null => {
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
      const text = claudeText(block[blockType]) ?? ''
      return { kind: 'start', ...started, text, parentToolUseId }
    }
    if (event.type === 'content_block_stop') {
      const stopped = messages.get(scope)?.blocks.get(index)
      return stopped ? { kind: 'stop', ...stopped, parentToolUseId } : null
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
    const started = streamed.blocks.get(index) ?? mint(streamed, sessionId, index, uuid, observedAt)
    return { kind: 'delta', ...started, text, parentToolUseId }
  }

  return {
    observe: (frame, observedAt) => {
      const event = observeBlock(frame, observedAt)
      return event && event.kind !== 'stop' && event.text
        ? {
            identity: event.identity,
            text: event.text,
            parentToolUseId: event.parentToolUseId,
            startedAt: event.startedAt
          }
        : null
    },
    observeBlock,
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
