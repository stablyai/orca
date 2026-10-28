import { readStreamedSessionDocument } from './session-document-stream'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorFoldResumeState,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
import {
  arrayValue,
  asRecord,
  extractContentText,
  extractString,
  parseJsonObject,
  tokenTotal
} from './session-scanner-values'

export async function parseGeminiSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  if (file.path.endsWith('.jsonl')) {
    return parseGeminiJsonlSessionFile(file, platform, messages)
  }

  return parseGeminiSessionDocument(
    file,
    openTranscriptReadStream(file.path, {}, 'scan'),
    platform,
    {},
    signal,
    messages
  )
}

export async function parseGeminiSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ResumableParseFinalizeOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  if (file.path.endsWith('.jsonl')) {
    return parseGeminiJsonlSessionLines({
      file,
      lines: remoteSessionContentLines(content, signal),
      platform,
      options
    })
  }
  return parseGeminiJsonSessionContent(file, content, platform, options)
}

function parseGeminiJsonSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform,
  options: ResumableParseFinalizeOptions = {},
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'gemini',
    file,
    sessionId: extractString(record.sessionId) ?? sessionIdFromFileName(file.path),
    messages
  })
  updateTimeline(accumulator, extractString(record.startTime))
  updateTimeline(accumulator, extractString(record.lastUpdated))
  for (const message of arrayValue(record.messages)) {
    consumeGeminiMessage(accumulator, asRecord(message))
  }
  return finalizeSession(accumulator, platform, options)
}

export async function parseGeminiJsonlSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseGeminiJsonlSessionLines({ file, lines, platform, messages })
}

function consumeGeminiJsonlRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  const setRecord = asRecord(record.$set)
  if (setRecord) {
    updateTimeline(accumulator, extractString(setRecord.lastUpdated))
    return
  }
  const sessionId = extractString(record.sessionId)
  if (sessionId) {
    accumulator.sessionId = sessionId
  }
  updateTimeline(accumulator, extractString(record.startTime))
  updateTimeline(accumulator, extractString(record.lastUpdated))
  consumeGeminiMessage(accumulator, record)
}

// Only JSONL is resumable; legacy Gemini documents are rewritten and require a whole-file read.
export function createGeminiJsonlSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({
      agent: 'gemini',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    consumeGeminiJsonlRecordLine
  )
}

export async function parseGeminiJsonlSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ResumableParseFinalizeOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createGeminiJsonlSessionResumeState(args.file, args.messages)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

export function consumeGeminiMessage(
  accumulator: SessionAccumulator,
  record: Record<string, unknown> | null
): void {
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  if (record.type === 'user') {
    accumulator.messageCount++
    accumulator.title ??= extractContentText(record.content)
    addSessionContent(accumulator, 'user', record.content, record.timestamp)
    return
  }
  if (record.type === 'gemini') {
    accumulator.messageCount++
    addSessionContent(accumulator, 'assistant', record.content, record.timestamp)
    const model = extractString(record.model)
    if (model) {
      accumulator.model = model
    }
    accumulator.totalTokens += tokenTotal(record.tokens)
  }
}

export async function parseGeminiSessionDocument(
  file: FileWithMtime,
  bytes: AsyncIterable<Buffer>,
  platform: NodeJS.Platform,
  options: ResumableParseFinalizeOptions,
  signal?: AbortSignal,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const parsed = await readStreamedSessionDocument({
    bytes,
    arrayKey: 'messages',
    fields: ['sessionId', 'startTime', 'lastUpdated'],
    create: () => {
      messages?.reset?.()
      return createAccumulator({
        agent: 'gemini',
        file,
        sessionId: sessionIdFromFileName(file.path),
        messages
      })
    },
    consume: (state, value) => consumeGeminiMessage(state, asRecord(value)),
    signal
  })
  if (!parsed) {
    return null
  }
  const { record, state: accumulator } = parsed
  accumulator.sessionId = extractString(record.sessionId) ?? sessionIdFromFileName(file.path)
  updateTimeline(accumulator, extractString(record.startTime))
  updateTimeline(accumulator, extractString(record.lastUpdated))
  return finalizeSession(accumulator, platform, options)
}
