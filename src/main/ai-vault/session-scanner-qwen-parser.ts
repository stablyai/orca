import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  accumulatorFoldResumeState,
  addPreviewMessage,
  createAccumulator,
  sessionIdFromFileName,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  arrayValue,
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

// Qwen Code (a Gemini CLI fork) stores one append-only transcript per session at
// ~/.qwen/projects/<encoded-cwd>/chats/<sessionId>.jsonl. Every record carries
// its own cwd/gitBranch/timestamp, so no sidecar index is needed (unlike Kimi).
export async function parseQwenSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const state = createQwenSessionResumeState(file)
  try {
    const lines = createInterface({
      input: createReadStream(file.path, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      state.consumeLine(line)
    }
  } catch {
    // Unreadable/empty transcript — still list a metadata-only session.
  }
  return state.finalize(platform)
}

// Resumable fold so the parse cache only reads newly appended lines on
// subsequent scans, like the other append-only JSONL agents.
export function createQwenSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'qwen-code', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeQwenSessionLine
  )
}

function consumeQwenSessionLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  const sessionId = extractString(record.sessionId)
  if (sessionId) {
    accumulator.sessionId = sessionId
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  updateLatestLocation(accumulator, record)

  const message = asRecord(record.message)
  if (record.type === 'user') {
    const text = qwenMessagePartsText(arrayValue(message?.parts), false)
    if (!text) {
      return
    }
    accumulator.messageCount++
    accumulator.title ??= normalizeTitleText(text)
    addPreviewMessage(accumulator, { role: 'user', text, timestamp: record.timestamp })
    return
  }
  if (record.type === 'assistant') {
    // Why: capture the model before the text gate — a thought-only or tool-only
    // turn carries record.model but no visible reply text.
    accumulator.model = extractString(record.model) ?? accumulator.model
    // Skip `thought` parts — the model's private reasoning is not a real reply.
    const text = qwenMessagePartsText(arrayValue(message?.parts), true)
    if (!text) {
      return
    }
    accumulator.messageCount++
    addPreviewMessage(accumulator, { role: 'assistant', text, timestamp: record.timestamp })
  }
}

// Joins the `text` of a record's message parts. With excludeThought set, parts
// flagged `thought: true` (the model's private reasoning) are dropped so titles
// and previews show only the real reply. Normalization (hidden-block stripping,
// length caps) happens downstream in normalizeTitleText/addPreviewMessage.
function qwenMessagePartsText(parts: unknown[], excludeThought: boolean): string | null {
  const chunks: string[] = []
  for (const item of parts) {
    const part = asRecord(item)
    if (typeof part?.text !== 'string') {
      continue
    }
    if (excludeThought && part.thought === true) {
      continue
    }
    chunks.push(part.text)
  }
  return chunks.length > 0 ? chunks.join('') : null
}
