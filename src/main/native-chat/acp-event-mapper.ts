// Maps ACP `session/update` notifications onto the native chat conversation
// model. Kept free of transport concerns (no spawning, no JSON-RPC) so the
// mapping is unit-testable against literal notification payloads — the same
// split the JSONL decoders use (transcript-line-decoders.ts).
//
// Why an accumulator rather than a pure per-notification decoder: ACP streams
// an assistant turn as many `agent_message_chunk` deltas, each carrying a
// fragment of text and no id. Emitting one message per chunk would render the
// reply as dozens of separate bubbles. Instead we keep the in-flight turn's
// accumulated text keyed by a stable id and re-emit the whole message on every
// chunk; the renderer's merger dedups by id (NATIVE_CHAT_SOURCE_PRIORITY) and
// replaces the previous copy, which is exactly streaming-append semantics.

import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'

/** The `update` object inside a `session/update` notification. Deliberately
 *  loose: the ACP schema evolves, and an unknown `sessionUpdate` must be
 *  skipped rather than thrown (same schema-drift stance as the JSONL decoders). */
export type AcpSessionUpdate = {
  sessionUpdate?: unknown
  [key: string]: unknown
}

export type AcpDecodeResult = {
  /** Messages to append/replace. Empty when the update carried no renderable
   *  content (mode changes, command lists, unknown variants). */
  messages: NativeChatMessage[]
  /** Set only when the update is explicit turn-boundary evidence. */
  lifecycle?: NativeChatTurnLifecycle
}

const EMPTY: AcpDecodeResult = { messages: [] }

/** ACP content blocks we can render. `audio` and bare `resource` payloads are
 *  skipped — the conversation model has no block for them. */
function decodeContentBlock(content: unknown): NativeChatBlock | null {
  if (content == null || typeof content !== 'object') {
    return null
  }
  const block = content as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : null
  if (type === 'text') {
    return typeof block.text === 'string' ? { type: 'text', text: block.text } : null
  }
  if (type === 'image') {
    // ACP sends either an inline data payload or a URI. The conversation model
    // only references images, so prefer the URI and fall back to the data URI.
    const uri = typeof block.uri === 'string' ? block.uri : null
    const data = typeof block.data === 'string' ? block.data : null
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
    if (uri) {
      return { type: 'image-ref', url: uri }
    }
    return data ? { type: 'image-ref', url: `data:${mimeType};base64,${data}` } : null
  }
  if (type === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : null
    const name = typeof block.name === 'string' ? block.name : uri
    return uri && name ? { type: 'text', text: `[${name}](${uri})` } : null
  }
  return null
}

/** Concatenate the text of a content block list, ignoring non-text parts. Used
 *  for tool results, which the model represents as a single output string. */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) {
    const single = decodeContentBlock(content)
    return single && single.type === 'text' ? single.text : ''
  }
  const parts: string[] = []
  for (const entry of content) {
    // Tool results nest the payload one level deeper under `content`.
    const inner =
      entry != null && typeof entry === 'object' && 'content' in (entry as object)
        ? (entry as Record<string, unknown>).content
        : entry
    const block = decodeContentBlock(inner)
    if (block && block.type === 'text') {
      parts.push(block.text)
    }
  }
  return parts.join('')
}

/** ACP `agent_thought_chunk` maps to the reasoning role so the renderer can
 *  collapse it the way it collapses Claude/Codex reasoning records. */
const CHUNK_ROLES: Record<string, NativeChatRole> = {
  user_message_chunk: 'user',
  agent_message_chunk: 'assistant',
  agent_thought_chunk: 'reasoning'
}

export type AcpTurnAccumulator = {
  /** Decode one `session/update` payload into messages to emit. */
  decode: (update: AcpSessionUpdate, timestamp?: number | null) => AcpDecodeResult
  /** Close the in-flight turn (prompt returned / session stopped) so the next
   *  chunk starts a fresh message instead of appending to a finished reply. */
  endTurn: (state?: 'completed' | 'interrupted', timestamp?: number | null) => AcpDecodeResult
}

/**
 * Create a stateful mapper for one ACP session.
 *
 * `sessionId` scopes the generated message ids so two concurrently open chat
 * tabs never collide. Ids are deterministic (`acp-<session>-<turn>-<role>`)
 * so a re-emitted streaming message replaces its earlier copy.
 */
export function createAcpTurnAccumulator(sessionId: string): AcpTurnAccumulator {
  let turnIndex = 0
  /** Accumulated text of the in-flight message, per role within this turn. */
  const streaming = new Map<NativeChatRole, string>()
  /** Tool calls seen this session, so a `tool_call_update` can re-emit the
   *  original title/input alongside the newly arrived result. */
  const toolCalls = new Map<string, { name: string; input: unknown; turn: number }>()

  function messageId(role: NativeChatRole, turn: number): string {
    return `acp-${sessionId}-${turn}-${role}`
  }

  function emitStreaming(
    role: NativeChatRole,
    text: string,
    timestamp: number | null
  ): AcpDecodeResult {
    const previous = streaming.get(role) ?? ''
    const next = previous + text
    streaming.set(role, next)
    return {
      messages: [
        {
          id: messageId(role, turnIndex),
          role,
          blocks: [{ type: 'text', text: next }],
          timestamp,
          source: 'acp',
          turnId: `acp-${sessionId}-${turnIndex}`
        }
      ]
    }
  }

  return {
    decode(update, timestamp = Date.now()) {
      if (update == null || typeof update !== 'object') {
        return EMPTY
      }
      const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : null
      if (kind == null) {
        return EMPTY
      }
      const at = timestamp ?? null

      const chunkRole = CHUNK_ROLES[kind]
      if (chunkRole) {
        // A user chunk means the operator's prompt opened a new turn; roll the
        // turn index so the assistant reply that follows gets fresh ids.
        if (chunkRole === 'user' && streaming.size > 0) {
          turnIndex += 1
          streaming.clear()
        }
        const block = decodeContentBlock(update.content)
        if (block == null) {
          return EMPTY
        }
        if (block.type !== 'text') {
          // Non-text content (an image) is a whole message, not a delta.
          return {
            messages: [
              {
                id: `${messageId(chunkRole, turnIndex)}-${block.type}-${streaming.size}`,
                role: chunkRole,
                blocks: [block],
                timestamp: at,
                source: 'acp',
                turnId: `acp-${sessionId}-${turnIndex}`
              }
            ]
          }
        }
        return emitStreaming(chunkRole, block.text, at)
      }

      if (kind === 'tool_call') {
        const toolCallId =
          typeof update.toolCallId === 'string' ? update.toolCallId : `tool-${toolCalls.size}`
        const name =
          typeof update.title === 'string'
            ? update.title
            : typeof update.kind === 'string'
              ? update.kind
              : 'tool'
        const input = 'rawInput' in update ? update.rawInput : undefined
        toolCalls.set(toolCallId, { name, input, turn: turnIndex })
        return {
          messages: [
            {
              id: `acp-${sessionId}-tool-${toolCallId}`,
              role: 'tool',
              blocks: [{ type: 'tool-call', name, input }],
              timestamp: at,
              source: 'acp',
              turnId: `acp-${sessionId}-${turnIndex}`
            }
          ]
        }
      }

      if (kind === 'tool_call_update') {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null
        if (toolCallId == null) {
          return EMPTY
        }
        const status = typeof update.status === 'string' ? update.status : null
        // Only a terminal status carries a result worth rendering; in-progress
        // updates would just re-render the same call block.
        if (status !== 'completed' && status !== 'failed') {
          return EMPTY
        }
        const known = toolCalls.get(toolCallId)
        const output = contentToText(update.content)
        const blocks: NativeChatBlock[] = []
        if (known) {
          blocks.push({ type: 'tool-call', name: known.name, input: known.input })
        }
        blocks.push({ type: 'tool-result', output, isError: status === 'failed' })
        return {
          messages: [
            {
              id: `acp-${sessionId}-tool-${toolCallId}`,
              role: 'tool',
              blocks,
              timestamp: at,
              source: 'acp',
              turnId: `acp-${sessionId}-${known?.turn ?? turnIndex}`
            }
          ]
        }
      }

      // `plan`, `available_commands_update`, `current_mode_update` and any
      // future variant carry no conversation content.
      return EMPTY
    },

    endTurn(state = 'completed', timestamp = Date.now()) {
      const turnId = `acp-${sessionId}-${turnIndex}`
      const hadContent = streaming.size > 0
      streaming.clear()
      turnIndex += 1
      if (!hadContent && state === 'completed') {
        return EMPTY
      }
      return {
        messages: [],
        lifecycle: { state, turnId, timestamp: timestamp ?? null }
      }
    }
  }
}
