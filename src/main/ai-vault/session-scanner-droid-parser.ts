import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  accumulatorFoldResumeState,
  addPreviewMessage,
  createAccumulator,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractMessageText,
  extractPreviewContentText,
  extractString,
  normalizeTitleText,
  parseJsonObject,
  tokenTotal
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseDroidSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseDroidSessionLines({ file, lines, platform })
}

export async function parseDroidSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseDroidSessionLines({
    file,
    lines: content.split(/\r?\n/),
    platform,
    options
  })
}

function consumeDroidRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, record.timestamp)
  if (record.type === 'session_start') {
    accumulator.sessionId = extractString(record.id) ?? accumulator.sessionId
    accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
    accumulator.cwd = extractString(record.cwd) ?? accumulator.cwd
    return
  }
  if (record.type === 'system') {
    accumulator.cwd = extractString(record.cwd) ?? accumulator.cwd
    accumulator.model = extractString(record.model) ?? accumulator.model
  }
  const streamSessionId = extractString(record.session_id) ?? extractString(record.sessionId)
  if (streamSessionId) {
    accumulator.sessionId = streamSessionId
  }
  if (record.type === 'message') {
    consumeDroidMessage(accumulator, record)
  } else if (record.type === 'completion') {
    accumulator.messageCount++
    accumulator.totalTokens += tokenTotal(record.usage)
    addPreviewMessage(accumulator, {
      role: 'assistant',
      text: extractString(record.finalText),
      timestamp: record.timestamp
    })
  }
}

export function createDroidSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'droid', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeDroidRecordLine
  )
}

async function parseDroidSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createDroidSessionResumeState(args.file)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

function consumeDroidMessage(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  const role = extractString(record.role) ?? extractString(asRecord(record.message)?.role)
  if (role !== 'user' && role !== 'assistant') {
    return
  }
  accumulator.messageCount++
  if (role === 'user') {
    accumulator.title ??=
      normalizeTitleText(extractString(record.text) ?? '') ||
      extractMessageText(asRecord(record.message))
  }
  addPreviewMessage(accumulator, {
    role,
    text:
      extractString(record.text) ?? extractPreviewContentText(asRecord(record.message)?.content),
    timestamp: record.timestamp
  })
}
