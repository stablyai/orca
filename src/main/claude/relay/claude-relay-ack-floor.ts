import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeOf(frame: Record<string, unknown>): string {
  return `${String(frame.session_id ?? '')}/${String(frame.parent_tool_use_id ?? '')}`
}

function contentIds(frame: Record<string, unknown>, type: string, key: string): string[] {
  const message = isRecord(frame.message) ? frame.message : null
  const content = Array.isArray(message?.content) ? message.content : []
  return content.flatMap((part) =>
    isRecord(part) && part.type === type && typeof part[key] === 'string' ? [part[key]] : []
  )
}

/**
 * A streamed Claude message is matched to its final frame in memory, and a tool call to its result,
 * so a later attach must replay from the `message_start`: acks stop just before the oldest message
 * whose final hasn't landed or whose tool calls haven't returned.
 */
export function claudeRelayAckFloor(): ProviderRelayAckFloor {
  /** Each stream scope's open message, by the seq of its `message_start`. */
  const open = new Map<string, number>()
  /** Each scope's latest `message_start`, for the tool calls in its later final frames. */
  const starts = new Map<string, number>()
  /** Unreturned tool calls, by the seq of their message's `message_start`. */
  const tools = new Map<string, number>()
  return {
    observe: (seq, line) => {
      // Cheap tests first: only stream starts, final assistant frames and results matter.
      if (
        !line.includes('"message_start"') &&
        !line.includes('"message_stop"') &&
        !line.includes('"assistant"') &&
        !line.includes('"result"') &&
        !line.includes('"tool_result"')
      ) {
        return
      }
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (!isRecord(frame)) {
        return
      }
      if (frame.type === 'result') {
        // A turn's end closes every stream it had, including one the CLI never finished.
        open.clear()
        starts.clear()
        tools.clear()
      } else if (frame.type === 'assistant') {
        const scope = scopeOf(frame)
        const start = starts.get(scope) ?? seq
        // The CLI sends one final frame per block, before the message's stop.
        contentIds(frame, 'tool_use', 'id').forEach((id) => tools.set(id, start))
      } else if (frame.type === 'user') {
        contentIds(frame, 'tool_result', 'tool_use_id').forEach((id) => tools.delete(id))
      } else if (
        frame.type === 'stream_event' &&
        isRecord(frame.event) &&
        frame.event.type === 'message_stop'
      ) {
        open.delete(scopeOf(frame))
      } else if (
        frame.type === 'stream_event' &&
        isRecord(frame.event) &&
        frame.event.type === 'message_start'
      ) {
        open.set(scopeOf(frame), seq)
        starts.set(scopeOf(frame), seq)
      }
    },
    // The CLI's keep-alive while a request is open, every 30 s: short, with nothing to save.
    quiet: (line) => line.length < 256 && line.includes('"type":"keep_alive"'),
    floor: () =>
      open.size === 0 && tools.size === 0 ? null : Math.min(...open.values(), ...tools.values())
  }
}
