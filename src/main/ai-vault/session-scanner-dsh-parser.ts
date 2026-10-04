import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  FileWithMtime,
  SessionAccumulator,
  ResumableParseFinalizeOptions
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'
import { dshHistoryMessage } from './session-scanner-dsh-message'
import { dshGenerationVersion } from './session-scanner-dsh-generations'
import { dshTranscriptLines, localDshTranscriptBytes } from './session-scanner-dsh-stream'

// Physical schemas: official Harness 639ed015, session-format-v0-to-v1 through v3-to-v4.
export async function parseDshSessionBytes(
  file: FileWithMtime,
  bytes: AsyncIterable<Buffer> | (() => AsyncIterable<Buffer>),
  platform: NodeJS.Platform,
  options: ResumableParseFinalizeOptions = {},
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseDshHistoryPass(file, bytes, platform, options, messages, signal)
}

async function parseDshHistoryPass(
  file: FileWithMtime,
  bytes: AsyncIterable<Buffer> | (() => AsyncIterable<Buffer>),
  platform: NodeJS.Platform,
  options: ResumableParseFinalizeOptions,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal,
  inheritedCut?: number
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({ agent: 'dsh', file, sessionId: '', messages })
  let header = false
  let seeded = false
  let lastInheritedCut: number | undefined
  let version = 0
  let seedLength = 0
  let sequence = 0
  for await (const line of dshTranscriptLines(
    file.path,
    typeof bytes === 'function' ? bytes() : bytes,
    signal
  )) {
    const record = parseJsonObject(line)
    if (!record) {
      throw new Error('Malformed DSH history record')
    }
    if (!header) {
      const headerVersion = record.version
      if (
        typeof headerVersion !== 'number' ||
        headerVersion < 0 ||
        headerVersion > 4 ||
        !Number.isInteger(headerVersion)
      ) {
        throw new Error('Unsupported DSH history format; update the transcript-owning Orca host')
      }
      version = headerVersion
      if (
        record.type !== 'session' ||
        version !== dshGenerationVersion(file.path) ||
        !extractString(record.id)
      ) {
        throw new Error('DSH history header does not match its generation')
      }
      if (
        typeof record.createdAt !== 'number' ||
        !Number.isSafeInteger(record.createdAt) ||
        record.createdAt < 0 ||
        typeof record.delegationDepth !== 'number' ||
        !Number.isSafeInteger(record.delegationDepth) ||
        record.delegationDepth < 0 ||
        (version >= 2 && typeof record.isSeeded !== 'boolean') ||
        (record.seedLength !== undefined &&
          (typeof record.seedLength !== 'number' ||
            !Number.isSafeInteger(record.seedLength) ||
            record.seedLength < 0))
      ) {
        throw new Error('Malformed DSH history ownership/seed header')
      }
      if (record.origin === 'subagent' || numberValue(record.delegationDepth) > 0) {
        return null
      }
      accumulator.sessionId = extractString(record.id) ?? ''
      accumulator.cwd = extractString(record.cwd)
      updateTimeline(accumulator, record.createdAt)
      seeded = version >= 2 && record.isSeeded === true
      if (inheritedCut !== undefined && !seeded) {
        throw new Error('DSH seed ownership changed during its execution-host reread')
      }
      seedLength = version < 2 ? numberValue(record.seedLength) : 0
      header = true
      continue
    }
    // Old packed deltas occupy several sequence slots but are not settled messages.
    const packed = typeof record.seq0 === 'number' && asRecord(record.data)
    if (packed) {
      const data = asRecord(record.data)
      const chunks = data?.texts ?? data?.args
      if (record.seq0 !== sequence || !Array.isArray(chunks)) {
        throw new Error('DSH history sequence gap')
      }
      sequence += chunks.length
      continue
    }
    if (record.seq !== sequence++) {
      throw new Error('DSH history sequence gap')
    }
    const data = asRecord(record.data)
    if (!data) {
      throw new Error('Malformed DSH history event data')
    }
    updateTimeline(accumulator, record.time)
    if (record.type === 'session/end-seed' && data.inherited === true) {
      lastInheritedCut = numberValue(record.seq)
      if (version >= 2 && !seeded) {
        throw new Error('DSH unseeded history contains an inherited boundary')
      }
      continue
    }
    if (
      (seeded && inheritedCut === undefined) ||
      numberValue(record.seq) < (inheritedCut ?? seedLength)
    ) {
      continue
    }
    foldDshEvent(accumulator, record, data, version)
  }
  if (seedLength > sequence) {
    throw new Error('DSH legacy inherited seed exceeds its event count')
  }
  if (seeded) {
    if (lastInheritedCut === undefined) {
      throw new Error('DSH seeded history is missing its inherited boundary')
    }
    if (inheritedCut === undefined) {
      if (typeof bytes !== 'function') {
        throw new Error('DSH seeded history requires an execution-host reread')
      }
      // Forks retain earlier markers: find the final cut before publishing any messages.
      return parseDshHistoryPass(file, bytes, platform, options, messages, signal, lastInheritedCut)
    }
    if (lastInheritedCut !== inheritedCut) {
      throw new Error('DSH inherited boundary changed during its execution-host reread')
    }
  }
  return header ? finalizeSession(accumulator, platform, options) : null
}

function foldDshEvent(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>,
  data: Record<string, unknown>,
  version: number
): void {
  if (record.type === 'session/title') {
    accumulator.title = normalizeTitleText(extractString(data.title) ?? '') ?? accumulator.title
  }
  if (record.type === 'request/header') {
    const model = asRecord(data.header)
    accumulator.model ??=
      extractString(asRecord(model?.config)?.model) ?? extractString(model?.model)
  }
  const decoded = dshHistoryMessage(record.type, data, version)
  if (!decoded) {
    return
  }
  const { role, content, source } = decoded
  if (role !== 'tool') {
    accumulator.messageCount++
  }
  addPreviewContent(accumulator, role, content, record.time)
  if (role === 'user') {
    accumulator.title ??= normalizeTitleText(
      extractString(asRecord(Array.isArray(content) ? content[0] : null)?.text) ?? ''
    )
  }
  if (role === 'assistant') {
    accumulator.model ??= extractString(source?.model)
    const usage = asRecord(data.usage)
    accumulator.totalTokens +=
      numberValue(usage?.totalTokens) ||
      numberValue(usage?.inputTokens) +
        numberValue(usage?.outputTokens) +
        numberValue(usage?.cacheReadTokens) +
        numberValue(usage?.cacheWriteTokens)
  }
}

export function parseDshSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseDshSessionBytes(
    file,
    () => localDshTranscriptBytes(file.path, signal),
    platform,
    {},
    messages,
    signal
  )
}
