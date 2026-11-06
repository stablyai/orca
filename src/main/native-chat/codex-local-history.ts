import { createHash } from 'node:crypto'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { codexHistorySources, codexPhysicalRolloutId } from './codex-rollout-history-source'
import { readCodexRolloutBytes } from './codex-rollout-history-stream'
import { splitTranscriptStreamLines } from './transcript-stream-lines'
import { isCodexVisibleHistoryRecord } from './transcript-line-decoders-codex'
import { transcriptFallbackId } from './transcript-fallback-id'

type HistoryPosition = {
  thread_id: string
  end_ordinal_exclusive: number
  end_byte_offset: number
}

type HistorySegment = {
  path: string
  rolloutId: string
  headerDigest: string | null
  paginated: boolean
  start: number
  end?: HistoryPosition
}

/** Resolve physical prefixes only; logical fork parents can describe standalone copied files. */
export async function readCodexLocalHistory(input: {
  filePath: string
  roots?: readonly string[]
  visit: (line: string, fallbackId: string, selected: boolean, recordId?: string) => void
}): Promise<number> {
  const sources = await codexHistorySources(input.filePath, input.roots)
  const seen = new Set<string>()
  const segments: HistorySegment[] = []
  let path = sources.path
  let end: HistoryPosition | undefined
  for (;;) {
    const rolloutId = codexPhysicalRolloutId(path) ?? sessionIdFromFileName(path)
    if (seen.has(path) || seen.has(rolloutId)) {
      throw new Error('The conversation history lineage is invalid.')
    }
    seen.add(path)
    seen.add(rolloutId)
    if (end && rolloutId !== end.thread_id.toLowerCase()) {
      throw new Error('The conversation history source identity is invalid.')
    }
    let header: string | null = null
    for await (const raw of lines(path, end)) {
      if (raw.line.trim()) {
        header = raw.line
        break
      }
    }
    const record = header ? parseJsonObject(header) : null
    const metadata = record?.type === 'session_meta' ? asRecord(record.payload) : null
    const paginated = metadata?.history_mode === 'paginated'
    const base = metadata?.history_base == null ? undefined : historyPosition(metadata.history_base)
    if ((end || base) && !paginated) {
      throw new Error('The conversation history source is not paginated.')
    }
    segments.push({
      path,
      rolloutId,
      headerDigest: header === null ? null : digestHeader(header),
      paginated,
      start: base?.end_ordinal_exclusive ?? 0,
      end
    })
    if (!base) {
      break
    }
    path = await sources.resolve(base.thread_id)
    end = base
  }
  let bytes = 0
  for (const segment of segments.toReversed()) {
    let offset = 0
    let ordinal = segment.start
    let first = true
    const strictOrdinals = segment.end !== undefined
    for await (const raw of lines(segment.path, segment.end)) {
      offset += raw.byteLength
      bytes += raw.byteLength
      if (!raw.line.trim()) {
        continue
      }
      if (first) {
        first = false
        if (digestHeader(raw.line) !== segment.headerDigest) {
          throw new Error('The conversation history source changed during import.')
        }
      }
      const record = parseJsonObject(raw.line)
      if (
        strictOrdinals &&
        (record?.ordinal !== ordinal ||
          (segment.end && (!raw.terminated || ordinal >= segment.end.end_ordinal_exclusive)))
      ) {
        throw new Error('The conversation history ordinal or byte boundary is invalid.')
      }
      ordinal += 1
      if (isCodexVisibleHistoryRecord(record, segment.paginated)) {
        const payload = asRecord(record?.payload)
        const item = asRecord(payload?.item)
        const id =
          extractString(item?.id) ?? extractString(payload?.id) ?? extractString(record?.id)
        input.visit(
          raw.line,
          transcriptFallbackId(segment.path, offset - raw.byteLength),
          segment.end === undefined,
          segment.paginated ? `${segment.rolloutId}:${id ?? `#${ordinal - 1}`}` : undefined
        )
      }
    }
    if (
      (first && segment.headerDigest !== null) ||
      (segment.end &&
        (offset !== segment.end.end_byte_offset || ordinal !== segment.end.end_ordinal_exclusive))
    ) {
      throw new Error('The conversation history prefix is truncated or mismatched.')
    }
  }
  return bytes
}

function lines(path: string, end?: HistoryPosition) {
  return splitTranscriptStreamLines(
    readCodexRolloutBytes(path, end?.end_byte_offset),
    16 * 1024 * 1024
  )
}

function digestHeader(line: string): string {
  return createHash('sha256').update(line).digest('hex')
}

function historyPosition(value: unknown): HistoryPosition {
  const record = asRecord(value)
  const thread_id = extractString(record?.thread_id)
  const end_ordinal_exclusive = record?.end_ordinal_exclusive
  const end_byte_offset = record?.end_byte_offset
  if (
    !thread_id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread_id) ||
    typeof end_ordinal_exclusive !== 'number' ||
    !Number.isSafeInteger(end_ordinal_exclusive) ||
    end_ordinal_exclusive < 1 ||
    typeof end_byte_offset !== 'number' ||
    !Number.isSafeInteger(end_byte_offset) ||
    end_byte_offset < 1
  ) {
    throw new Error('The conversation history position is invalid.')
  }
  return { thread_id, end_ordinal_exclusive, end_byte_offset }
}
