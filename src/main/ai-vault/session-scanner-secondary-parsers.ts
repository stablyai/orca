import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
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
  const accumulator = createAccumulator({
    agent: 'copilot',
    file,
    sessionId: sessionIdFromFileName(file.path)
  })
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    updateTimeline(accumulator, extractString(record.timestamp))
    const data = asRecord(record.data)
    if (record.type === 'session.start' && data) {
      const sessionId = extractString(data.sessionId)
      if (sessionId) {
        accumulator.sessionId = sessionId
      }
      updateTimeline(accumulator, extractString(data.startTime))
      continue
    }
    if (record.type === 'session.model_change' && data) {
      accumulator.model = extractString(data.newModel) ?? accumulator.model
      continue
    }
    if (record.type === 'session.info' && data) {
      accumulator.cwd = extractTrustedFolder(data.message) ?? accumulator.cwd
      continue
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
      continue
    }
    if (record.type === 'assistant.message' && data) {
      accumulator.messageCount++
      addPreviewMessage(accumulator, {
        role: 'assistant',
        text: extractString(data.content),
        timestamp: record.timestamp
      })
      continue
    }
    if (record.type === 'session.shutdown' && data) {
      accumulator.model = extractString(data.currentModel) ?? accumulator.model
      accumulator.totalTokens += numberValue(data.currentTokens)
      accumulator.totalTokens += copilotModelMetricsTotal(data.modelMetrics)
    }
  }

  return finalizeSession(accumulator, platform)
}

export async function parseCursorSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'cursor',
    file,
    sessionId: sessionIdFromFileName(file.path)
  })
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    updateTimeline(accumulator, extractString(record.timestamp))
    const role = extractString(record.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      if (role === 'user') {
        accumulator.title ??=
          extractMessageText(record.message) ?? extractContentText(record.content)
      }
      addPreviewContent(
        accumulator,
        role,
        asRecord(record.message)?.content ?? record.content,
        record.timestamp
      )
    }
  }
  return finalizeSession(accumulator, platform)
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
  const record = asRecord(JSON.parse(await readFile(file.path, 'utf-8')) as unknown)
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
  return finalizeSession(accumulator, platform)
}
