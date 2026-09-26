import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { unwrapMuseLogRecords } from '../../shared/muse-session-log'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { museSessionIdFromFilePath } from './session-scanner-muse-paths'
import {
  arrayValue,
  asRecord,
  extractString,
  normalizeTitleText,
  numberValue,
  parseJsonObject,
  timestampMs
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

type MuseRecord = {
  recordType: string | null
  payloadType: string | null
  recordedAtMs: number | null
  payload: Record<string, unknown> | null
}

// Why: `recorded_at` is microseconds since epoch; the shared timeline helpers
// take milliseconds (or ISO strings), so convert here. Values below the
// microsecond floor fall through to the shared parser (seconds/ISO).
function museTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1e14) {
    return Math.floor(value / 1000)
  }
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unwrapMuseRecords(line: string): MuseRecord[] {
  const envelope = parseJsonObject(line)
  if (!envelope) {
    return []
  }
  // Why: retention markers (`retained_marker: omitted_live_only`) stand in for
  // ephemeral records excluded from the retained log — no payload to fold.
  return unwrapMuseLogRecords(envelope).map((record) => ({
    recordType: extractString(record.record_type),
    payloadType: extractString(record.payload_type),
    recordedAtMs: museTimestampMs(record.recorded_at),
    payload: asRecord(record.payload)
  }))
}

function firstTextBlock(value: unknown): string | null {
  for (const block of arrayValue(value)) {
    const text = extractString(asRecord(block)?.text)
    if (text) {
      return text
    }
  }
  return null
}

// Why: user intent arrives either as `refill_blocks` text blocks or nested
// `model_messages[].content[]` blocks; both shapes carry the same prompt.
function userIntentText(payload: Record<string, unknown>): string | null {
  return (
    firstTextBlock(payload.refill_blocks) ??
    (() => {
      for (const message of arrayValue(payload.model_messages)) {
        const text = firstTextBlock(asRecord(message)?.content)
        if (text) {
          return text
        }
      }
      return null
    })()
  )
}

function foldUserTurn(
  accumulator: SessionAccumulator,
  text: string | null,
  timestampMs: number | null,
  dedupe: { text: string | null; ms: number | null },
  // Why: each turn emits both `runtime.user_intent.accepted` and a `run ::
  // started` carrying the same prompt ~ms apart — folding both double-counts
  // turns and evicts real rows from the 5-message preview window. The intent
  // record always folds; `run.started` is the fallback for logs missing intent
  // records, so only it dedupes (a deliberately repeated prompt still counts).
  skipIfDuplicate: boolean
): void {
  if (!text) {
    return
  }
  if (
    skipIfDuplicate &&
    dedupe.text === text &&
    dedupe.ms !== null &&
    timestampMs !== null &&
    Math.abs(timestampMs - dedupe.ms) < 60_000
  ) {
    return
  }
  dedupe.text = text
  dedupe.ms = timestampMs
  accumulator.messageCount++
  const titleCandidate = normalizeTitleText(text)
  if (titleCandidate) {
    accumulator.title ??= titleCandidate
  }
  addPreviewContent(accumulator, 'user', text, timestampMs ?? undefined)
}

function foldMuseRecord(
  accumulator: SessionAccumulator,
  record: MuseRecord,
  dedupe: { text: string | null; ms: number | null }
): void {
  if (record.recordedAtMs !== null) {
    updateTimeline(accumulator, record.recordedAtMs)
  }
  const payload = record.payload
  if (!payload) {
    return
  }
  switch (record.payloadType) {
    case 'runtime.session.metadata': {
      // Why: the representative cwd is the session's start directory; later
      // drift must not move history grouping or the resume `cd` prefix.
      accumulator.cwd ??= extractString(asRecord(payload.record)?.workspace_root)
      break
    }
    case 'runtime.session.route_facts': {
      // Newer Muse logs carry the execution cwd in route facts as well as
      // metadata; retain it as a fallback for partially written sessions.
      accumulator.cwd ??= extractString(asRecord(payload.record)?.cwd)
      break
    }
    case 'session.workspace_branch.observed': {
      const reference = asRecord(asRecord(payload.record)?.reference)
      accumulator.branch ??= extractString(reference?.name)
      break
    }
    case 'run.model.configured': {
      accumulator.model ??= extractString(asRecord(payload.record)?.model_id)
      break
    }
    case 'runtime.user_intent.accepted': {
      foldUserTurn(accumulator, userIntentText(payload), record.recordedAtMs, dedupe, false)
      break
    }
    case 'runtime.session': {
      foldSessionEvent(accumulator, payload, record.recordedAtMs, dedupe)
      break
    }
    case null:
    default:
      break
  }
}

function foldSessionEvent(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  timestampMs: number | null,
  dedupe: { text: string | null; ms: number | null }
): void {
  const event = asRecord(payload.event)
  if (!event) {
    return
  }
  switch (event.kind) {
    case 'started': {
      foldUserTurn(accumulator, extractString(event.prompt), timestampMs, dedupe, true)
      break
    }
    case 'assistant_message_committed': {
      const text = extractString(event.text)
      if (text) {
        accumulator.messageCount++
        addPreviewContent(accumulator, 'assistant', text, timestampMs ?? undefined)
      }
      break
    }
    case 'model_completed': {
      const usage = asRecord(event.usage)
      accumulator.totalTokens +=
        numberValue(usage?.input_tokens) + numberValue(usage?.output_tokens)
      accumulator.model ??= extractString(event.model)
      break
    }
    case null:
    default:
      break
  }
}

type MuseDedupeState = { text: string | null; ms: number | null }

function foldMuseContent(accumulator: SessionAccumulator, content: string): void {
  foldMuseLines(accumulator, content.split('\n'))
}

function foldMuseLines(
  accumulator: SessionAccumulator,
  lines: Iterable<string>,
  dedupe: MuseDedupeState = { text: null, ms: null }
): void {
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    for (const record of unwrapMuseRecords(line)) {
      foldMuseRecord(accumulator, record, dedupe)
    }
  }
}

/** Parses remote transcript chunks without requiring the scanner to buffer the file. */
export async function parseMuseSessionRemoteContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'muse',
    file,
    sessionId: museSessionIdFromFilePath(file.path)
  })
  const lines = remoteSessionContentLines(content, signal)
  const dedupe: MuseDedupeState = { text: null, ms: null }
  for await (const line of lines) {
    foldMuseLines(accumulator, [line], dedupe)
  }
  return finalizeSession(accumulator, platform, options)
}

export async function parseMuseSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  return parseMuseSessionContent(
    file,
    await wslGatedReadFile(file.path, 'utf-8', 'scan'),
    platform,
    {},
    messages
  )
}

export function parseMuseSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  const accumulator = createAccumulator({
    agent: 'muse',
    file,
    sessionId: museSessionIdFromFilePath(file.path),
    messages
  })
  foldMuseContent(accumulator, content)
  return finalizeSession(accumulator, platform, options)
}
