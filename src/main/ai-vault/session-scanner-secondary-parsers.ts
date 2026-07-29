import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  addPreviewContent,
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  arrayValue,
  asRecord,
  copilotModelMetricsTotal,
  extractContentText,
  extractMessageText,
  extractPreviewContentText,
  extractString,
  extractTrustedFolder,
  findOpenCodeStorageRoot,
  normalizeTitleText,
  numberValue,
  parseJsonObject,
  timeObjectValue,
  tokenTotal
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export async function parseCopilotSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseCopilotSessionLines({ file, lines, platform })
}

export async function parseCopilotSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseCopilotSessionLines({
    file,
    lines: content.split(/\r?\n/),
    platform,
    options
  })
}

function consumeCopilotRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const data = asRecord(record.data)
  if (record.type === 'session.start' && data) {
    const sessionId = extractString(data.sessionId)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    updateTimeline(accumulator, extractString(data.startTime))
    return
  }
  if (record.type === 'session.model_change' && data) {
    accumulator.model = extractString(data.newModel) ?? accumulator.model
    return
  }
  if (record.type === 'session.info' && data) {
    accumulator.cwd = extractTrustedFolder(data.message) ?? accumulator.cwd
    return
  }
  if (record.type === 'user.message' && data) {
    accumulator.messageCount++
    accumulator.title ??= normalizeTitleText(
      extractString(data.transformedContent) ?? extractString(data.content) ?? ''
    )
    addPreviewMessage(accumulator, {
      role: 'user',
      text: extractString(data.transformedContent) ?? extractString(data.content),
      timestamp: record.timestamp
    })
    return
  }
  if (record.type === 'assistant.message' && data) {
    accumulator.messageCount++
    addPreviewMessage(accumulator, {
      role: 'assistant',
      text: extractString(data.content),
      timestamp: record.timestamp
    })
    return
  }
  if (record.type === 'session.shutdown' && data) {
    accumulator.model = extractString(data.currentModel) ?? accumulator.model
    accumulator.totalTokens += numberValue(data.currentTokens)
    accumulator.totalTokens += copilotModelMetricsTotal(data.modelMetrics)
  }
}

export function createCopilotSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'copilot', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeCopilotRecordLine
  )
}

async function parseCopilotSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createCopilotSessionResumeState(args.file)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

export async function parseCursorSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseCursorSessionLines({ file, lines, platform })
}

export async function parseCursorSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseCursorSessionLines({
    file,
    lines: content.split(/\r?\n/),
    platform,
    options
  })
}

function consumeCursorRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const role = extractString(record.role)
  if (role === 'user' || role === 'assistant') {
    accumulator.messageCount++
    if (role === 'user') {
      accumulator.title ??= extractMessageText(record.message) ?? extractContentText(record.content)
    }
    addPreviewContent(
      accumulator,
      role,
      asRecord(record.message)?.content ?? record.content,
      record.timestamp
    )
  }
}

export function createCursorSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent: 'cursor', file, sessionId: sessionIdFromFileName(file.path) }),
    consumeCursorRecordLine
  )
}

async function parseCursorSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createCursorSessionResumeState(args.file)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

export async function parseOpenCodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const record = asRecord(JSON.parse(await readFile(file.path, 'utf-8')) as unknown)
  if (!record) {
    return null
  }
  const sessionId = extractString(record.id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'opencode', file, sessionId })
  accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
  accumulator.cwd = extractString(record.directory)
  updateTimeline(accumulator, timeObjectValue(record.time, 'created'))
  updateTimeline(accumulator, timeObjectValue(record.time, 'updated'))
  await consumeOpenCodeMessages(accumulator, findOpenCodeStorageRoot(file.path), sessionId)
  return finalizeSession(accumulator, platform)
}

export async function consumeOpenCodeMessages(
  accumulator: SessionAccumulator,
  storageRoot: string | null,
  sessionId: string
): Promise<void> {
  if (!storageRoot) {
    return
  }
  const messageDir = join(storageRoot, 'message', sessionId)
  let entries
  try {
    entries = await readdir(messageDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    const message = asRecord(
      JSON.parse(await readFile(join(messageDir, entry.name), 'utf-8')) as unknown
    )
    if (!message) {
      continue
    }
    const role = extractString(message.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      updateTimeline(accumulator, timeObjectValue(message.time, 'created'))
      if (role === 'user') {
        accumulator.title ??= extractString(asRecord(message.summary)?.title)
        accumulator.title ??= extractString(asRecord(message.summary)?.body)
      }
      addPreviewMessage(accumulator, {
        role,
        text:
          extractPreviewContentText(message.content) ??
          extractString(asRecord(message.summary)?.body) ??
          extractString(asRecord(message.summary)?.title),
        timestamp: timeObjectValue(message.time, 'created')
      })
      accumulator.model =
        extractString(asRecord(message.model)?.modelID) ||
        extractString(message.modelID) ||
        accumulator.model
      accumulator.totalTokens += tokenTotal(message.tokens)
    }
  }
}

export async function parseHermesSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  return parseHermesSessionContent(file, await readFile(file.path, 'utf-8'), platform)
}

export async function parseHermesSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'hermes',
    file,
    sessionId: extractString(record.session_id) ?? sessionIdFromFileName(file.path)
  })
  accumulator.model = extractString(record.model)
  accumulator.cwd = extractString(record.cwd)
  updateTimeline(accumulator, extractString(record.session_start))
  updateTimeline(accumulator, extractString(record.last_updated))
  for (const message of arrayValue(record.messages)) {
    const messageRecord = asRecord(message)
    const role = extractString(messageRecord?.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      if (role === 'user') {
        accumulator.title ??= extractContentText(messageRecord?.content)
      }
      addPreviewContent(accumulator, role, messageRecord?.content)
    }
  }
  if (accumulator.messageCount === 0) {
    accumulator.messageCount = numberValue(record.message_count)
  }
  return finalizeSession(accumulator, platform, options)
}
