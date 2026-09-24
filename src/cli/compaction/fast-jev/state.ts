import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult
} from './types.js'

export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.'

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const
const TEXT_HEAD = 400
const TEXT_TAIL = 150

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated
 * against the usage Jev reports for real transcripts, where it lands 2–18%
 * above the true count; a plain characters-per-token ratio undercounts the
 * JSON-heavy states by up to 40%.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) {
      tokens += piece.length / 2
    } else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6)
    } else {
      tokens += 0.9
    }
  }
  return Math.ceil(tokens)
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) {
    return text
  }
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`
}

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>()
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result })
    }
  })
  const calls: ToolCall[] = []
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id)
      if (!found) {
        continue
      }
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages)
      })
    }
  })
  return calls
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = ''
  try {
    json = JSON.stringify(input)
  } catch {
    json = '[unserializable input]'
  }
  return truncate(json, limit)
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : inputText({ [key]: value }, 200)
      return `${key}=${text.replace(/\s+/g, ' ')}`
    })
    .join(' ')
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(
  history: readonly HistoryEntry[],
  pinned: (e: HistoryEntry) => boolean
): HistoryEntry[] {
  const merged: HistoryEntry[] = []
  for (const entry of history) {
    const previous = merged.at(-1)
    const foldable = (e: HistoryEntry): boolean =>
      !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string'
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [
        ...(previous.tool_calls as string[]),
        ...(entry.tool_calls as string[])
      ]
      continue
    }
    merged.push({ ...entry })
  }
  return merged
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>()
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? []
    list.push(call)
    byMessage.set(call.callIndex, list)
  }
  return byMessage
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number
): HistoryEntry[] {
  const byMessage = callsByMessage(calls)
  const entries: HistoryEntry[] = []
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call)
    }))
    if (message.text.trim().length === 0 && toolCalls.length === 0) {
      return
    }
    const entry: HistoryEntry = { i, role: message.role, text: message.text }
    if (toolCalls.length > 0) {
      entry.tool_calls = toolCalls
    }
    entries.push(entry)
  })
  return entries
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n')
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages
 * until it fits `maxStateTokens`: tool inputs are truncated, then long texts
 * are abridged oldest-first (pinned messages last), then old messages collapse
 * to a one-line note, then old tool calls shrink to one line each, then old
 * messages that carry no call are left out, then runs of old call-only
 * messages are folded into one entry. Throws when even that is too big.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'>
): FittedState {
  const goal = options.goal || goalFromMessages(messages)
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history
  })
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])))
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage
  })

  let history: HistoryEntry[] = []
  let perEntry: number[] = []
  let tokens = 0
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars)
    perEntry = history.map(entryTokens)
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  }
  const fits = (): boolean => tokens <= options.maxStateTokens
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index]
    if (!entry) {
      return
    }
    change(entry)
    const now = entryTokens(entry)
    tokens += now - (perEntry[index] ?? 0)
    perEntry[index] = now
  }

  rebuild(INPUT_CHARS[0])
  if (fits()) {
    return fitted(history, tokens, 'full')
  }

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit)
    if (fits()) {
      return fitted(history, tokens, `inputs<=${limit}`)
    }
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages)
  const indices = history.map((_, index) => index)
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!))
  ]

  for (const index of order) {
    const entry = history[index]!
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) {
      continue
    }
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL)
    })
    if (fits()) {
      return fitted(history, tokens, 'texts abridged')
    }
  }

  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.text.length === 0) {
      continue
    }
    const original = messages[entry.i]?.text.length ?? entry.text.length
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`
    })
    if (fits()) {
      return fitted(history, tokens, 'old messages collapsed')
    }
  }

  const byMessage = callsByMessage(calls)
  for (const index of order) {
    const entry = history[index]!
    const own = byMessage.get(entry.i)
    if (pinned(entry) || !own) {
      continue
    }
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall)
    })
    if (fits()) {
      return fitted(history, tokens, 'old calls compacted')
    }
  }

  const left = new Set<number>()
  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.tool_calls) {
      continue
    }
    left.add(index)
    tokens -= perEntry[index] ?? 0
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out'
      )
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned
  )
  perEntry = history.map(entryTokens)
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  if (fits()) {
    return fitted(history, tokens, 'old calls merged')
  }

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`
  )
}
