import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { musecodeSessionIdFromFilePath } from './session-scanner-musecode-paths'
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

type MusecodeRecord = {
  recordType: string | null
  payloadType: string | null
  recordedAtMs: number | null
  payload: Record<string, unknown> | null
}

// Why: `recorded_at` is microseconds since epoch; the shared timeline helpers
// take milliseconds (or ISO strings), so convert here. Values below the
// microsecond floor fall through to the shared parser (seconds/ISO).
function musecodeTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1e14) {
    return Math.floor(value / 1000)
  }
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unwrapMusecodeRecords(line: string): MusecodeRecord[] {
  const envelope = parseJsonObject(line)
  if (!envelope) {
    return []
  }
  // Why: retention markers (`retained_marker: omitted_live_only`) stand in for
  // ephemeral records excluded from the retained log — no payload to fold.
  const rawRecords: unknown[] = Array.isArray(envelope.children)
    ? envelope.children.map((child) => asRecord(child)?.record_json)
    : [envelope]
  const records: MusecodeRecord[] = []
  for (const raw of rawRecords) {
    const record = typeof raw === 'string' ? parseJsonObject(raw) : asRecord(raw)
    if (!record) {
      continue
    }
    records.push({
      recordType: extractString(record.record_type),
      payloadType: extractString(record.payload_type),
      recordedAtMs: musecodeTimestampMs(record.recorded_at),
      payload: asRecord(record.payload)
    })
  }
  return records
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

function foldMusecodeRecord(
  accumulator: SessionAccumulator,
  record: MusecodeRecord,
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

function foldMusecodeContent(accumulator: SessionAccumulator, content: string): void {
  const dedupe = { text: null as string | null, ms: null as number | null }
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue
    }
    for (const record of unwrapMusecodeRecords(line)) {
      foldMusecodeRecord(accumulator, record, dedupe)
    }
  }
}

export async function parseMusecodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  return parseMusecodeSessionContent(
    file,
    await wslGatedReadFile(file.path, 'utf-8', 'scan'),
    platform
  )
}

export function parseMusecodeSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  const accumulator = createAccumulator({
    agent: 'musecode',
    file,
    sessionId: musecodeSessionIdFromFilePath(file.path)
  })
  foldMusecodeContent(accumulator, content)
  return finalizeSession(accumulator, platform, options)
}
