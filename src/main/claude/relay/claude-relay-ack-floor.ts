import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeOf(frame: Record<string, unknown>): string {
  return `${String(frame.session_id ?? '')}/${String(frame.parent_tool_use_id ?? '')}`
}

/**
 * A streamed Claude message is matched to its final frame in memory, so a later attach must replay
 * it from its `message_start`: acks stop just before the oldest message whose final hasn't landed.
 */
export function claudeRelayAckFloor(): ProviderRelayAckFloor {
  /** Each stream scope's open message, by the seq of its `message_start`. */
  const open = new Map<string, number>()
  return {
    observe: (seq, line) => {
      // Cheap tests first: only stream starts, final assistant frames and results matter.
      if (
        !line.includes('"message_start"') &&
        !line.includes('"assistant"') &&
        !line.includes('"result"')
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
      } else if (frame.type === 'assistant') {
        open.delete(scopeOf(frame))
      } else if (
        frame.type === 'stream_event' &&
        isRecord(frame.event) &&
        frame.event.type === 'message_start'
      ) {
        open.set(scopeOf(frame), seq)
      }
    },
    ceiling: () => (open.size === 0 ? null : Math.min(...open.values()) - 1)
  }
}
