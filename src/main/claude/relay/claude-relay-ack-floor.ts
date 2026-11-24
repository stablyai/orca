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
const TYPE_PREFIX = '{"type":"'
/** What a line of each type must contain to matter; null parses it, a type not listed is skipped. */
const NEEDLES: Readonly<Record<string, string | null>> = {
  stream_event: '"message_st',
  assistant: '"tool_use"',
  user: '"tool_result"',
  system: '"task_',
  result: null
}
/** A line that doesn't start with its type (no CLI writes one) is checked the slow way. */
const UNORDERED_NEEDLES = ['"message_st', '"assistant"', '"result"', '"tool_result"', '"task_']

export function claudeRelayAckFloor(): ProviderRelayAckFloor {
  /** Each stream scope's open message, by the seq of its `message_start`. */
  const open = new Map<string, number>()
  /** Each scope's latest `message_start`, for the tool calls in its later final frames. */
  const starts = new Map<string, number>()
  /** Unreturned tool calls, by the seq of their message's `message_start`, and their scope. */
  const tools = new Map<string, { seq: number; scope: string }>()
  /** Tool calls that launched a background task; their subagent outlives the call's result. */
  const backgroundLaunches = new Set<string>()
  /** Each running task's launching call, for one moved to the background after it started. */
  const launchOf = new Map<string, string>()
  const closeScope = (scope: string): void => {
    open.delete(scope)
    starts.delete(scope)
    for (const [id, tool] of tools) {
      if (tool.scope === scope) {
        tools.delete(id)
      }
    }
  }
  return {
    observe: (seq, line) => {
      // One prefix read and at most one scan per line: the CLI writes `type` first. Only stream
      // starts and stops, tool calls, tool results, task ends and results matter.
      const type = line.startsWith(TYPE_PREFIX)
        ? line.slice(TYPE_PREFIX.length, line.indexOf('"', TYPE_PREFIX.length))
        : null
      const needle = type === null ? null : NEEDLES[type]
      if (needle === undefined || (needle !== null && !line.includes(needle))) {
        return
      }
      if (type === null && !UNORDERED_NEEDLES.some((key) => line.includes(key))) {
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
        // A turn's end closes its own streams, even one the CLI never finished; a background
        // subagent's work goes on past it.
        closeScope(scopeOf(frame))
      } else if (frame.type === 'system' && frame.subtype === 'task_notification') {
        // A subagent's end closes what it left open under its launching tool call.
        backgroundLaunches.delete(String(frame.tool_use_id ?? ''))
        launchOf.delete(String(frame.task_id ?? ''))
        closeScope(`${String(frame.session_id ?? '')}/${String(frame.tool_use_id ?? '')}`)
      } else if (frame.type === 'system' && frame.subtype === 'task_started') {
        if (typeof frame.task_id === 'string' && typeof frame.tool_use_id === 'string') {
          launchOf.set(frame.task_id, frame.tool_use_id)
        }
        if (frame.is_backgrounded === true && typeof frame.tool_use_id === 'string') {
          backgroundLaunches.add(frame.tool_use_id)
        }
      } else if (frame.type === 'system' && frame.subtype === 'task_updated') {
        const launch = typeof frame.task_id === 'string' ? launchOf.get(frame.task_id) : undefined
        if (launch && isRecord(frame.patch) && frame.patch.is_backgrounded === true) {
          backgroundLaunches.add(launch)
        }
      } else if (frame.type === 'assistant') {
        const scope = scopeOf(frame)
        const start = starts.get(scope) ?? seq
        // The CLI sends one final frame per block, before the message's stop.
        contentIds(frame, 'tool_use', 'id').forEach((id) => tools.set(id, { seq: start, scope }))
      } else if (frame.type === 'user') {
        for (const id of contentIds(frame, 'tool_result', 'tool_use_id')) {
          tools.delete(id)
          // A foreground subagent ends with its launching call's result.
          if (!backgroundLaunches.has(id)) {
            closeScope(`${String(frame.session_id ?? '')}/${id}`)
          }
        }
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
    floor: () =>
      open.size === 0 && tools.size === 0
        ? null
        : Math.min(...open.values(), ...[...tools.values()].map((tool) => tool.seq))
  }
}
