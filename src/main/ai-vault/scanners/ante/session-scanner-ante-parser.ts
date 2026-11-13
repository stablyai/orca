import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  openTranscriptReadStream,
  wslGatedReadFile
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { anteTranscriptPathForMetadata } from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import type { FileWithMtime, SessionAccumulator } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionText } from '../../parsing/session-scanner-messages'
import { asRecord } from '../../parsing/session-record-fields'
import { extractString } from '../../../../shared/trimmed-string'
import { numberValue } from '../../parsing/session-scanner-token-values'
import { parseJsonObject } from '../../parsing/session-json-object'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import { anteSessionIdFromMetadataPath } from './session-scanner-ante-paths'

// `events.jsonl` is append-only and one turn emits several records, so the fold reads every line:
// a bounded prefix would drop later messages from the search sink and hide the newest timeline
// entry. Only the preview text is bounded, as in the other line-oriented scanners.
const ANTE_PREVIEW_TEXT_LIMIT = 4_000
const ANTE_INJECTED_PROMPT_MARKER = '<folder-structure>'

type AnteMetadata = {
  id: string | null
  model: string | null
  cwd: string | null
  title: string | null
  totalTokens: number
  messageCount: number
  startedAt: string | null
  lastActiveAt: string | null
}

/**
 * Ante lists a session from `meta.json` (id, cwd, model, totals) and folds the sibling
 * `events.jsonl` for previews. Its records are `{ timestamp, id, event: { Variant } }`.
 */
export async function parseAnteSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const metadata = await readAnteMetadata(file.path, signal)
  if (!metadata) {
    return null
  }
  const sessionId = metadata.id ?? anteSessionIdFromMetadataPath(file.path)
  const accumulator = createAccumulator({ agent: 'ante', file, sessionId, messages })
  accumulator.cwd = metadata.cwd
  accumulator.title = metadata.title
  accumulator.model = metadata.model
  accumulator.totalTokens = metadata.totalTokens
  accumulator.messageCount = metadata.messageCount
  updateTimeline(accumulator, metadata.startedAt)
  updateTimeline(accumulator, metadata.lastActiveAt)
  await consumeAnteEvents(accumulator, anteTranscriptPathForMetadata(file.path), signal)
  return finalizeSession(accumulator, platform)
}

/** Scope selection reads cwd from `meta.json` without opening the transcript. */
export function anteMetadataCwd(content: string): string | null {
  return anteMetadata(content).cwd
}

/** Read the row's identity and totals from `meta.json`; a missing id falls back to the folder name. */
function anteMetadata(content: string): AnteMetadata {
  const record = asRecord(JSON.parse(content) as unknown) ?? {}
  const usage = asRecord(record.usage)
  return {
    id: extractString(record.id),
    model: extractString(record.model),
    cwd: extractString(record.dir),
    title: normalizeTitleText(antePromptText(extractString(record.first_user_message) ?? '')),
    totalTokens: numberValue(usage?.input_tokens) + numberValue(usage?.output_tokens),
    messageCount: numberValue(record.message_count),
    startedAt: extractString(record.started_time),
    lastActiveAt: extractString(record.last_active_time)
  }
}

/** Ante writes `meta.json` at turn end, so a live session may have no metadata to list yet. */
async function readAnteMetadata(
  metadataPath: string,
  signal?: AbortSignal
): Promise<AnteMetadata | null> {
  try {
    const content = await waitForAiVaultScan(
      wslGatedReadFile(metadataPath, 'utf-8', 'scan', signal),
      signal
    )
    return anteMetadata(content)
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    // WSL refusal must propagate so an unreadable session is not cached as absent.
    if (
      error instanceof WslTranscriptFsError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
    return null
  }
}

/** Ante appends an injected folder listing to the opening prompt; only the request titles a row. */
function antePromptText(text: string): string {
  const injected = text.indexOf(ANTE_INJECTED_PROMPT_MARKER)
  const request = injected === -1 ? text : text.slice(0, injected)
  return request.trim()
}

/** Fold every record: skips only bound the preview text, never the messages or the timeline. */
async function consumeAnteEvents(
  accumulator: SessionAccumulator,
  transcriptPath: string,
  signal?: AbortSignal
): Promise<void> {
  const input = openTranscriptReadStream(transcriptPath, { encoding: 'utf-8' }, 'scan', signal)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      await waitForAiVaultScan(accumulator.messages.drain?.() ?? Promise.resolve(), signal)
      consumeAnteEventLine(accumulator, line)
    }
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    // A missing or unreadable transcript still lists from `meta.json`; WSL refusal must propagate.
    if (
      error instanceof WslTranscriptFsError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
  } finally {
    // readline.close() leaves its input open; destroy the gated stream after read failures too.
    lines.close()
    input.destroy()
  }
}

/** Only `UserInput` and `AgentMessage` carry turn text; tool and usage records feed the timeline. */
function consumeAnteEventLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const event = asRecord(record.event)
  if (!event) {
    return
  }
  const role = typeof event.UserInput === 'string' ? 'user' : 'assistant'
  const raw = role === 'user' ? event.UserInput : event.AgentMessage
  if (typeof raw !== 'string') {
    return
  }
  const text = role === 'user' ? antePromptText(raw) : raw
  // `meta.json` is the row's message total, so folding must not count turns a second time (real
  // stores report ~4x more turns there than the two variants folded here).
  if (role === 'user') {
    accumulator.title ??= normalizeTitleText(text)
  }
  addSessionText(accumulator, {
    role,
    text,
    timestamp: record.timestamp,
    previewScanLimit: ANTE_PREVIEW_TEXT_LIMIT
  })
}
