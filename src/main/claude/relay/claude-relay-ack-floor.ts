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

export function claudeRelayAckFloor(): ProviderRelayAckFloor & {
  floor: (through?: number) => number | null
} {
  /** Each stream scope's open message, by the seq of its `message_start`. */
  const open = new Map<string, number>()
  /** Each scope's stopped messages in order, each held until the reader is past its stop: the
   *  floor sees a line when it is pushed, ahead of a paused reader. */
  const closed = new Map<string, { start: number; stop: number }[]>()
  /** Each scope's latest `message_start`, for the tool calls in its later final frames. */
  const starts = new Map<string, number>()
  /** Unreturned tool calls, by the seq of their message's `message_start`, and their scope. */
  const tools = new Map<string, { seq: number; scope: string }>()
  /** The same calls by scope, so ending a scope visits only its own. */
  const toolsByScope = new Map<string, Set<string>>()
  const dropTool = (id: string): void => {
    const tool = tools.get(id)
    if (tool) {
      tools.delete(id)
      toolsByScope.get(tool.scope)?.delete(id)
    }
  }
  /** Tool calls that launched a background task; their subagent outlives the call's result. */
  const backgroundLaunches = new Set<string>()
  /** Each running task's launching call, for one moved to the background after it started. */
  const launchOf = new Map<string, string>()
  /** Streams whose open message a forced ack released: every ack is a cut until it ends, so a
   *  reattach moves the tail it replays to a continuation row instead of a fresh one. */
  const releasedOpen = new Set<string>()
  /** Ends a scope at line `at`: what it opened through then goes (an ending line opens nothing, and a
   *  lift can move an older start onto it), what opened since stays. */
  const closeScope = (scope: string, at: number): void => {
    for (const map of [open, starts]) {
      if ((map.get(scope) ?? Number.POSITIVE_INFINITY) <= at) {
        map.delete(scope)
      }
    }
    if (!open.has(scope)) {
      releasedOpen.delete(scope)
    }
    for (const id of toolsByScope.get(scope) ?? []) {
      if ((tools.get(id)?.seq ?? Number.POSITIVE_INFINITY) <= at) {
        dropTool(id)
      }
    }
    if (toolsByScope.get(scope)?.size === 0) {
      toolsByScope.delete(scope)
    }
  }
  /** Scope ends (and a root result's lift), seen as lines are pushed, ahead of a paused reader:
   *  each applies only once the reader is past it, so a crash before then still replays whole. */
  const ends: { seq: number; scope: string; lift: boolean }[] = []
  const endsThrough = (through: number): void => {
    const due = ends.findIndex((end) => end.seq > through)
    const lifts: number[] = []
    for (const end of ends.splice(0, due === -1 ? ends.length : due)) {
      closeScope(end.scope, end.seq)
      if (end.lift) {
        keepAfter(end.seq)
        lifts.push(end.seq)
      }
    }
    liftStopped(lifts)
  }
  /** Lifts applied once the reader is past them, after a stream that crossed one may have stopped:
   *  each stop is visited once for all of them (`lifts` ascend), never once per lift. */
  const liftStopped = (lifts: readonly number[]): void => {
    const last = lifts.at(-1)
    if (last === undefined) {
      return
    }
    for (const stopped of closed.values()) {
      for (const message of stopped) {
        if (message.start > last) {
          continue
        }
        // The first lift at or past the start: the stream crossed it if it stopped after it.
        let low = 0
        let high = lifts.length
        while (low < high) {
          const mid = (low + high) >> 1
          if (lifts[mid] < message.start) {
            low = mid + 1
          } else {
            high = mid
          }
        }
        cut ||= low < lifts.length && lifts[low] < message.stop
        message.start = last + 1
      }
    }
  }
  /** A root result ends its turn, which the chat has saved: a replay never starts before it, so
   *  work still open past it (a background subagent's) is kept from the line after; a reattach
   *  restores such a running tool call from its saved row. */
  /** A lift past a still-streaming message's start: the next ack reports the cut. */
  let cut = false
  const keepAfter = (seq: number): void => {
    for (const from of open.values()) {
      cut ||= from <= seq
    }
    for (const map of [open, starts]) {
      for (const [scope, from] of map) {
        map.set(scope, Math.max(from, seq + 1))
      }
    }
    for (const tool of tools.values()) {
      tool.seq = Math.max(tool.seq, seq + 1)
    }
  }
  return {
    released: (seq) => {
      // The daemon dropped them through `seq`: they can't replay whole, so they hold nothing.
      for (const [scope, from] of open) {
        if (from <= seq) {
          releasedOpen.add(scope)
        }
      }
      for (const map of [open, starts]) {
        for (const [scope, from] of map) {
          if (from <= seq) {
            map.delete(scope)
          }
        }
      }
      for (const [id, tool] of tools) {
        if (tool.seq <= seq) {
          dropTool(id)
        }
      }
      for (const [scope, stopped] of closed) {
        const kept = stopped.filter(({ start }) => start > seq)
        if (kept.length === 0) {
          closed.delete(scope)
        } else {
          closed.set(scope, kept)
        }
      }
    },
    tookCut: () => {
      const took = cut || releasedOpen.size > 0
      cut = false
      return took
    },
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
        ends.push({ seq, scope: scopeOf(frame), lift: frame.parent_tool_use_id == null })
      } else if (frame.type === 'system' && frame.subtype === 'task_notification') {
        // A subagent's end closes what it left open under its launching tool call; one naming no
        // call is found by its task, and otherwise closes nothing (never the root's stream).
        const task = typeof frame.task_id === 'string' ? frame.task_id : ''
        const launch =
          typeof frame.tool_use_id === 'string' && frame.tool_use_id !== ''
            ? frame.tool_use_id
            : launchOf.get(task)
        launchOf.delete(task)
        if (launch) {
          backgroundLaunches.delete(launch)
          ends.push({ seq, scope: `${String(frame.session_id ?? '')}/${launch}`, lift: false })
        }
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
        for (const id of contentIds(frame, 'tool_use', 'id')) {
          tools.set(id, { seq: start, scope })
          toolsByScope.set(scope, (toolsByScope.get(scope) ?? new Set()).add(id))
        }
      } else if (frame.type === 'user') {
        for (const id of contentIds(frame, 'tool_result', 'tool_use_id')) {
          dropTool(id)
          // A foreground subagent ends with its launching call's result.
          if (!backgroundLaunches.has(id)) {
            ends.push({ seq, scope: `${String(frame.session_id ?? '')}/${id}`, lift: false })
          }
        }
      } else if (
        frame.type === 'stream_event' &&
        isRecord(frame.event) &&
        frame.event.type === 'message_stop'
      ) {
        const start = open.get(scopeOf(frame))
        if (start !== undefined) {
          const stopped = closed.get(scopeOf(frame))
          if (stopped) {
            stopped.push({ start, stop: seq })
          } else {
            closed.set(scopeOf(frame), [{ start, stop: seq }])
          }
        }
        open.delete(scopeOf(frame))
        releasedOpen.delete(scopeOf(frame))
      } else if (
        frame.type === 'stream_event' &&
        isRecord(frame.event) &&
        frame.event.type === 'message_start'
      ) {
        releasedOpen.delete(scopeOf(frame))
        open.set(scopeOf(frame), seq)
        starts.set(scopeOf(frame), seq)
      }
    },
    // `through`: how far the reader took; without it a stopped message holds nothing.
    floor: (through?: number) => {
      endsThrough(through ?? Number.POSITIVE_INFINITY)
      const held: number[] = []
      for (const [scope, stopped] of closed) {
        // Stops come in order, so the reader passed a prefix; the oldest left holds the scope.
        const passed =
          through === undefined ? stopped.length : stopped.findIndex(({ stop }) => stop > through)
        if (passed === -1 || passed === stopped.length) {
          closed.delete(scope)
        } else {
          stopped.splice(0, passed)
          held.push(stopped[0].start)
        }
      }
      return open.size === 0 && tools.size === 0 && held.length === 0
        ? null
        : Math.min(...open.values(), ...held, ...[...tools.values()].map((tool) => tool.seq))
    }
  }
}
