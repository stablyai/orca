import { openTranscriptReadStream, wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionContent, addSessionText } from './session-scanner-messages'
import {
  extractGrokFirstUserPromptText,
  stripGrokUserQueryEnvelope
} from './session-scanner-grok-user-text'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

const GROK_PREVIEW_SCAN_LIMIT = 4096

export async function parseGrokSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const record = asRecord(JSON.parse(await wslGatedReadFile(file.path, 'utf-8', 'scan')) as unknown)
  if (!record) {
    return null
  }
  const info = asRecord(record.info)
  const sessionId = extractString(info?.id) ?? sessionIdFromFileName(dirname(file.path))
  const accumulator = createAccumulator({ agent: 'grok', file, sessionId, messages })
  accumulator.cwd = grokSessionCwd(record)
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

/** Scope discovery reads cwd from the summary without opening history. */
export function grokSessionCwd(summary: Record<string, unknown>): string | null {
  return extractString(asRecord(summary.info)?.cwd)
}

async function consumeGrokChatHistory(
  accumulator: SessionAccumulator,
  sessionDir: string
): Promise<void> {
  const input = openTranscriptReadStream(
    join(sessionDir, 'chat_history.jsonl'),
    { encoding: 'utf-8' },
    'scan'
  )
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
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
        const text = extractGrokFirstUserPromptText(record.content)
        if (text) {
          accumulator.title ??= normalizeTitleText(text)
          addSessionText(accumulator, {
            role,
            text,
            timestamp: record.timestamp,
            previewScanLimit: GROK_PREVIEW_SCAN_LIMIT
          })
        }
        continue
      }

      addSessionContent(
        accumulator,
        role,
        typeof record.content === 'string'
          ? stripGrokUserQueryEnvelope(record.content)
          : record.content,
        record.timestamp,
        { previewScanLimit: GROK_PREVIEW_SCAN_LIMIT }
      )
    }
  } catch (error) {
    // Summary-only sessions can list; WSL refusal must propagate so incomplete history is not cached as current.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
  } finally {
    // readline.close() leaves its input open; destroy the gated stream after read failures too.
    lines.close()
    input.destroy()
  }
}
