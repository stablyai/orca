import type { ProviderRelayItemContinuation } from '../../provider-relay/relayed-provider-continuation'
import { CLAUDE_RELAY_CONTINUATION_KEY } from '../structured/journal/claude-streamed-block-identity'

type StreamLine = Record<string, unknown>

const STREAM_EVENT = '{"type":"stream_event","event":{"type":"'
const ASSISTANT = '{"type":"assistant"'
/** Statuses that end a task, as `terminalClaudeTaskRunState` reads them. */
export const CLAUDE_TERMINAL_TASK_STATUSES = ['completed', 'failed', 'killed', 'stopped'] as const
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(CLAUDE_TERMINAL_TASK_STATUSES)

/** The scope a line belongs to, from its trailing keys: the session and the launching call. */
function scopeKey(line: string): string {
  const read = (key: string): string => {
    const at = line.lastIndexOf(key)
    if (at === -1) {
      return ''
    }
    const from = at + key.length
    const end = line.indexOf(line[from] === '"' ? '"' : ',', from + 1)
    return line.slice(from, end === -1 ? undefined : end)
  }
  return `${read('"session_id":')}|${read('"parent_tool_use_id":')}`
}

function isRecord(value: unknown): value is StreamLine {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function streamLineAny(line: string): StreamLine | null {
  try {
    const frame: unknown = JSON.parse(line)
    return isRecord(frame) ? frame : null
  } catch {
    return null
  }
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
  // Read on every line while a cut replay is in play, so no parse: the CLI writes `type` first
  // and the scope keys last (a key inside the payload is an escaped string, never these bytes).
  item: (line) => {
    const event = line.startsWith(STREAM_EVENT)
      ? line.slice(STREAM_EVENT.length, line.indexOf('"', STREAM_EVENT.length))
      : line.startsWith(ASSISTANT)
        ? ''
        : null
    if (event === null) {
      return null
    }
    return {
      key: scopeKey(line),
      start: event === 'message_start',
      end: event === 'message_stop'
    }
  },
  // Keys as CLAUDE_RELAY_WORK_MARKERS' groups: `turn` [session_id], ended by a result or idle
  // state; `task` [task_id], ended by its notification or a terminal status (a background
  // subagent streams past its turn's result).
  openGroup: ['turn', 'task'],
  settles: (line) => {
    if (!line.startsWith('{"type":"result"') && !line.startsWith('{"type":"system"')) {
      return null
    }
    const turnEnds =
      line.startsWith('{"type":"result"') ||
      (line.includes('"session_state_changed"') && line.includes('"idle"'))
    const taskEnds =
      !turnEnds && (line.includes('"task_notification"') || line.includes('"task_updated"'))
    if (!turnEnds && !taskEnds) {
      return null
    }
    const frame = streamLineAny(line)
    if (!frame) {
      return null
    }
    if (turnEnds) {
      return typeof frame.session_id === 'string' ? JSON.stringify([frame.session_id]) : null
    }
    const status = isRecord(frame.patch) ? frame.patch.status : undefined
    const ended =
      frame.subtype === 'task_notification' ||
      (frame.subtype === 'task_updated' &&
        typeof status === 'string' &&
        TERMINAL_TASK_STATUSES.has(status))
    return ended && typeof frame.task_id === 'string' ? JSON.stringify([frame.task_id]) : null
  },
  // One row per cut, so no app's text can land on another's; finals too: one whose block
  // streamed nothing after the cut is placed by its block stop.
  rekey: (line, tag) => {
    const frame = streamLine(line)
    return frame ? JSON.stringify({ ...frame, [CLAUDE_RELAY_CONTINUATION_KEY]: tag }) : line
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
