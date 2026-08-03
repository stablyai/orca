import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
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
  normalizeFullFirstUserPromptText,
  shouldCaptureFullFirstUserPrompt
} from './session-scanner-first-user-prompt'
import {
  extractGrokFirstUserPromptText,
  stripGrokUserQueryEnvelope
} from './session-scanner-grok-user-text'
import {
  asRecord,
  extractPreviewContentText,
  extractString,
  normalizePreviewText,
  normalizeTitleText,
  numberValue,
  parseJsonObject,
  sliceAtCodeUnitLimit
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

      if (role === 'user') {
        // Why: first-prompt copy must be the typed ask inside <user_query>, never
        // the injected <user_info> bootstrap row.
        const firstPromptBody = extractGrokFirstUserPromptText(record.content)
        const text = firstPromptBody
          ? normalizePreviewText(capGrokPreviewSource(firstPromptBody))
          : null

        if (firstPromptBody) {
          accumulator.title ??= normalizeTitleText(firstPromptBody)
          if (shouldCaptureFullFirstUserPrompt() && !accumulator.firstUserPrompt) {
            accumulator.firstUserPrompt = normalizeFullFirstUserPromptText(firstPromptBody)
          }
        }

        if (text) {
          addPreviewMessage(accumulator, {
            role: 'user',
            text,
            timestamp: extractString(record.timestamp),
            seedFirstUserPrompt: false
          })
        }
        continue
      }

      addPreviewMessage(accumulator, {
        role: 'assistant',
        text: extractGrokContentText(record.content),
        timestamp: extractString(record.timestamp),
        seedFirstUserPrompt: false
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

function capGrokPreviewSource(text: string): string {
  return sliceAtCodeUnitLimit(text, GROK_USER_QUERY_PREVIEW_SCAN_LIMIT)
}

function extractGrokStringContentText(text: string): string | null {
  const unwrapped = stripGrokUserQueryEnvelope(text)
  return normalizePreviewText(capGrokPreviewSource(unwrapped))
}
