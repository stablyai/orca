/** Whether Claude's transcript shows a turn stuck after a tool returned: no model request was built
 *  for the tool's result. Claude writes an `api-request` row when it builds each request, retries
 *  included (Claude 2.1.325, 300 sessions), but only behind an internal flag, and a compaction's
 *  request writes none. So this says yes only when the transcript proves it, and null on any doubt. */
import { readClaudeTranscriptTailText } from './claude-transcript-tail-text'

// Many request rows, and the newest tool batch, fit well inside this.
const TAIL_BYTES = 512 * 1024

/** When the newest tool result was written, if no request followed it; else null. */
export function claudeToolReturnWithoutRequest(transcript: string): number | null {
  let requestSeen = false
  // The newest assistant message: its id, whether its reply finished, and its tool calls.
  let batch: { id: unknown; finished: boolean; uses: Set<string>; results: Set<string> } | null =
    null
  let lastResultAt: number | null = null
  for (const line of transcript.split('\n')) {
    const row = parseRow(line)
    if (!row) {
      continue
    }
    if (row.type === 'api-request') {
      requestSeen = true
      lastResultAt = null
      continue
    }
    // A subagent's rows are its own requests' business; metadata rows are not the conversation.
    if (
      row.isSidechain === true ||
      typeof row.type !== 'string' ||
      !CONVERSATION_ROWS.has(row.type)
    ) {
      continue
    }
    lastResultAt = null
    const message = isRecord(row.message) ? row.message : null
    const content = Array.isArray(message?.content) ? message.content : null
    if (row.type === 'assistant' && message) {
      if (!batch || batch.id !== message.id) {
        batch = { id: message.id, finished: false, uses: new Set(), results: new Set() }
      }
      // Every row of a reply carries its final stop reason (0 of 14,911 replies mixed); one cut off
      // mid-stream has none.
      batch.finished = message.stop_reason === 'tool_use'
      for (const block of content ?? []) {
        if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
          batch.uses.add(block.id)
        }
      }
      continue
    }
    const results = row.type === 'user' && content ? toolResultIds(content) : null
    const current = batch
    if (!results || !current) {
      continue
    }
    for (const id of results) {
      current.results.add(id)
    }
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (Number.isFinite(at) && results.every((id) => current.uses.has(id))) {
      lastResultAt = at
    }
  }
  // No request row anywhere means the recorder may be off for this session: that proves nothing.
  if (!requestSeen || lastResultAt === null || !batch?.finished || batch.uses.size === 0) {
    return null
  }
  // A sibling call still running feeds the same next request.
  return [...batch.uses].every((id) => batch.results.has(id)) ? lastResultAt : null
}

/** The tool's return time, only if it returned at least `quietMs` ago with no request since. */
export async function readClaudeToolReturnWithoutRequest(
  transcriptPath: string,
  quietMs: number,
  now = Date.now()
): Promise<number | null> {
  const text = await readClaudeTranscriptTailText(transcriptPath, TAIL_BYTES)
  const at = text === null ? null : claudeToolReturnWithoutRequest(text)
  return at !== null && now - at >= quietMs ? at : null
}

const CONVERSATION_ROWS = new Set(['user', 'assistant', 'system'])

/** A user row that is only tool results (a typed prompt or interrupt is something else). */
function toolResultIds(content: unknown[]): string[] | null {
  const ids: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      return null
    }
    ids.push(block.tool_use_id)
  }
  return ids.length > 0 ? ids : null
}

function parseRow(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) {
    return null
  }
  try {
    const row: unknown = JSON.parse(line)
    return isRecord(row) ? row : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
