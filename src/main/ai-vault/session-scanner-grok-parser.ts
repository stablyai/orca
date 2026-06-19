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
  extractString,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

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

function extractGrokContentText(value: unknown): string | null {
  const text = extractGrokRawContentText(value)
  if (!text) {
    return null
  }
  return text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1]?.trim() || text
}

function extractGrokRawContentText(value: unknown): string | null {
  if (typeof value === 'string') {
    return extractString(value)
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) || extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return extractString(parts.join(' '))
}
