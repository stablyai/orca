import { createReadStream } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractPreviewContentText,
  extractString,
  normalizePreviewText,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

const GROK_USER_QUERY_PREVIEW_SCAN_LIMIT = 4096

export async function parseGrokSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const record = asRecord(JSON.parse(await readFile(file.path, 'utf-8')) as unknown)
  if (!record) {
    return null
  }
  const info = asRecord(record.info)
  const sessionId = extractString(info?.id) ?? sessionIdFromFileName(dirname(file.path))
  const accumulator = createAccumulator({ agent: 'grok', file, sessionId })
  accumulator.cwd = extractString(info?.cwd)
  accumulator.title =
    normalizeTitleText(extractString(record.generated_title) ?? '') ??
    normalizeTitleText(extractString(record.session_summary) ?? '')
  accumulator.model = extractString(record.current_model_id)
  accumulator.branch = extractString(record.head_branch)
  accumulator.messageCount =
    numberValue(record.num_chat_messages) || numberValue(record.num_messages)
  updateTimeline(accumulator, extractString(record.created_at))
  updateTimeline(accumulator, extractString(record.updated_at))
  updateTimeline(accumulator, extractString(record.last_active_at))
  await consumeGrokChatHistory(accumulator, dirname(file.path))
  return finalizeSession(accumulator, platform)
}

async function consumeGrokChatHistory(
  accumulator: SessionAccumulator,
  sessionDir: string
): Promise<void> {
  try {
    const lines = createInterface({
      input: createReadStream(join(sessionDir, 'chat_history.jsonl'), { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })

    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const role = extractString(record.type)
      if (role !== 'user' && role !== 'assistant') {
        continue
      }
      const text = extractGrokContentText(record.content)
      if (role === 'user') {
        accumulator.title ??= normalizeTitleText(text ?? '')
      }
      addPreviewMessage(accumulator, {
        role,
        text,
        timestamp: extractString(record.timestamp)
      })
    }
  } catch {
    // Summary-only sessions still provide enough metadata for the Vault list.
  }
}

export function extractGrokContentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return extractGrokStringContentText(value)
  }
  return extractPreviewContentText(value)
}

function extractGrokStringContentText(text: string): string | null {
  const bounds = grokUserQueryEnvelopeBounds(text)
  if (!bounds) {
    return normalizePreviewText(text)
  }

  const boundedEnd = Math.min(bounds.end, bounds.start + GROK_USER_QUERY_PREVIEW_SCAN_LIMIT)
  return normalizePreviewText(text.slice(bounds.start, boundedEnd)) ?? normalizePreviewText(text)
}

function grokUserQueryEnvelopeBounds(text: string): { start: number; end: number } | null {
  const opener = '<user_query>'
  const startIndex = indexOfAsciiIgnoreCase(text, opener, 0)
  if (startIndex === -1) {
    return null
  }
  const bodyStartIndex = startIndex + opener.length
  const endIndex = indexOfAsciiIgnoreCase(text, '</user_query>', bodyStartIndex)
  if (endIndex === -1) {
    return null
  }
  return { start: bodyStartIndex, end: endIndex }
}

function indexOfAsciiIgnoreCase(value: string, search: string, fromIndex: number): number {
  const lastStart = value.length - search.length
  for (let index = Math.max(0, fromIndex); index <= lastStart; index++) {
    let matches = true
    for (let offset = 0; offset < search.length; offset++) {
      const code = value.charCodeAt(index + offset)
      const normalizedCode = code >= 65 && code <= 90 ? code + 32 : code
      if (normalizedCode !== search.charCodeAt(offset)) {
        matches = false
        break
      }
    }
    if (matches) {
      return index
    }
  }
  return -1
}
