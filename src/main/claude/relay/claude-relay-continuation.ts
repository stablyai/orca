import type { ProviderRelayItemContinuation } from '../../provider-relay/relayed-provider-continuation'
import { CLAUDE_RELAY_CONTINUATION_KEY } from '../structured/journal/claude-streamed-block-identity'

type StreamLine = Record<string, unknown>

function isRecord(value: unknown): value is StreamLine {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A streamed message's lines: its stream events and its per-block final frames. */
function streamLine(line: string): StreamLine | null {
  if (!line.startsWith('{"type":"stream_event"') && !line.startsWith('{"type":"assistant"')) {
    return null
  }
  try {
    const frame: unknown = JSON.parse(line)
    return isRecord(frame) ? frame : null
  } catch {
    return null
  }
}

/**
 * Claude streams one message at a time per scope (the session, or a subagent's launching call).
 * A message whose start a cut replay dropped streams under the continuation id, a row of its own;
 * its final frames carry the real message id and go on the row saved before the cut, retiring it.
 */
export const CLAUDE_RELAY_ITEM_CONTINUATION: ProviderRelayItemContinuation = {
  item: (line) => {
    const frame = streamLine(line)
    if (!frame) {
      return null
    }
    const event = frame.type === 'stream_event' && isRecord(frame.event) ? frame.event.type : null
    return {
      key: JSON.stringify([frame.session_id ?? null, frame.parent_tool_use_id ?? null]),
      start: event === 'message_start',
      end: event === 'message_stop'
    }
  },
  rekey: (line, tag) => {
    const frame = streamLine(line)
    return frame?.type === 'stream_event'
      ? JSON.stringify({ ...frame, [CLAUDE_RELAY_CONTINUATION_KEY]: tag })
      : line
  },
  start: (line, tag) => {
    const frame = streamLine(line)
    return JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: tag } },
      session_id: frame?.session_id ?? null,
      parent_tool_use_id: frame?.parent_tool_use_id ?? null
    })
  }
}
