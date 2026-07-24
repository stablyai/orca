import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { iterateAiVaultJsonlLines } from './session-jsonl-line-reader'
import { withAiVaultWholeJsonFile } from './session-whole-json-reader'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  ResumableParseFinalizeOptions,
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

export async function parseCopilotSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = iterateAiVaultJsonlLines(file.path)
  return parseCopilotSessionLines({ file, lines, platform })
}

export async function parseCopilotSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ResumableParseFinalizeOptions = {}
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
  options?: ResumableParseFinalizeOptions
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
  const lines = iterateAiVaultJsonlLines(file.path)
  return parseCursorSessionLines({ file, lines, platform })
}

export async function parseCursorSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ResumableParseFinalizeOptions = {}
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
  options?: ResumableParseFinalizeOptions
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
  const parsed = await withAiVaultWholeJsonFile(file.path, (content) => {
    const record = parseJsonObject(content)
    if (!record) {
      return null
    }
    const sessionId = extractString(record.id) ?? sessionIdFromFileName(file.path)
    const accumulator = createAccumulator({ agent: 'opencode', file, sessionId })
    accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
    accumulator.cwd = extractString(record.directory)
    updateTimeline(accumulator, timeObjectValue(record.time, 'created'))
    updateTimeline(accumulator, timeObjectValue(record.time, 'updated'))
    return { accumulator, sessionId }
  })
  if (!parsed) {
    return null
  }
  await consumeOpenCodeMessages(
    parsed.accumulator,
    findOpenCodeStorageRoot(file.path),
    parsed.sessionId
  )
  return finalizeSession(parsed.accumulator, platform)
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
  try {
    const directory = await opendir(messageDir)
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      await withAiVaultWholeJsonFile(join(messageDir, entry.name), (content) => {
        const message = parseJsonObject(content)
        if (!message) {
          return
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
      })
    }
  } catch {
    // Missing or unreadable message directories contribute no messages.
  }
}

export async function parseHermesSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  return withAiVaultWholeJsonFile(file.path, (content) =>
    parseHermesSessionContent(file, content, platform)
  )
}

export async function parseHermesSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ResumableParseFinalizeOptions = {}
): Promise<AiVaultSession | null> {
  const record = parseJsonObject(content)
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
