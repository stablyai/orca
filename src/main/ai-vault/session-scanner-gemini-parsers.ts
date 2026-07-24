import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  accumulatorFoldResumeState,
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
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
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  if (file.path.endsWith('.jsonl')) {
    return parseGeminiJsonlSessionFile(file, platform)
  }

  return parseGeminiJsonSessionContent(file, await readFile(file.path, 'utf-8'), platform)
}

export async function parseGeminiSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ResumableParseFinalizeOptions = {}
): Promise<AiVaultSession | null> {
  if (file.path.endsWith('.jsonl')) {
    return parseGeminiJsonlSessionLines({
      file,
      lines: content.split(/\r?\n/),
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
  options: ResumableParseFinalizeOptions = {}
): AiVaultSession | null {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'gemini',
    file,
    sessionId: extractString(record.sessionId) ?? sessionIdFromFileName(file.path)
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
  platform: NodeJS.Platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseGeminiJsonlSessionLines({ file, lines, platform })
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

// Resumable only for the JSONL log format; Gemini's legacy single-JSON
// session documents are rewritten in place and must be re-read whole.
export function createGeminiJsonlSessionResumeState(
  file: FileWithMtime
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'gemini', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeGeminiJsonlRecordLine
  )
}

async function parseGeminiJsonlSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ResumableParseFinalizeOptions
}): Promise<AiVaultSession | null> {
  const state = createGeminiJsonlSessionResumeState(args.file)
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
    addPreviewContent(accumulator, 'user', record.content, record.timestamp)
    return
  }
  if (record.type === 'gemini') {
    accumulator.messageCount++
    addPreviewContent(accumulator, 'assistant', record.content, record.timestamp)
    const model = extractString(record.model)
    if (model) {
      accumulator.model = model
    }
    accumulator.totalTokens += tokenTotal(record.tokens)
  }
}
