import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import {
  arrayValue,
  asRecord,
  claudeUsageTotal,
  extractContentText,
  extractMessageText,
  extractString,
  normalizeTitleText,
  parseJsonObject,
  tokenTotal
} from './session-scanner-values'

export async function parseClaudeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'claude',
    file,
    sessionId: sessionIdFromFileName(file.path)
  })
  let metaTitle: string | null = null
  let generatedTitle: string | null = null

  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }

    if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
      accumulator.sessionId = record.sessionId.trim()
    }
    updateTimeline(accumulator, extractString(record.timestamp))
    updateLatestLocation(accumulator, record)

    if (record.type === 'custom-title') {
      accumulator.title = normalizeTitleText(extractString(record.customTitle) ?? '')
      continue
    }

    if (record.type === 'ai-title') {
      generatedTitle ??= normalizeTitleText(extractString(record.aiTitle) ?? '')
      continue
    }

    if (record.type === 'agent-name' && !generatedTitle) {
      metaTitle ??= normalizeTitleText(extractString(record.agentName) ?? '')
      continue
    }

    if (record.type === 'user') {
      accumulator.messageCount++
      const title = extractMessageText(record.message)
      addPreviewContent(accumulator, 'user', asRecord(record.message)?.content, record.timestamp)
      if (title && record.isMeta !== true && !accumulator.title) {
        accumulator.title = title
      } else if (title && !metaTitle) {
        metaTitle = title
      }
      continue
    }

    if (record.type === 'assistant') {
      accumulator.messageCount++
      const message = asRecord(record.message)
      addPreviewContent(accumulator, 'assistant', message?.content, record.timestamp)
      const model = extractString(message?.model)
      if (model) {
        accumulator.model = model
      }
      accumulator.totalTokens += claudeUsageTotal(message?.usage)
    }
  }

  accumulator.fallbackTitle = generatedTitle ?? metaTitle
  return finalizeSession(accumulator, platform)
}

export async function parseGeminiSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  if (file.path.endsWith('.jsonl')) {
    return parseGeminiJsonlSessionFile(file, platform)
  }

  const record = asRecord(JSON.parse(await readFile(file.path, 'utf-8')) as unknown)
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
  return finalizeSession(accumulator, platform)
}

export async function parseGeminiJsonlSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'gemini',
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
    const setRecord = asRecord(record.$set)
    if (setRecord) {
      updateTimeline(accumulator, extractString(setRecord.lastUpdated))
      continue
    }
    const sessionId = extractString(record.sessionId)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    updateTimeline(accumulator, extractString(record.startTime))
    updateTimeline(accumulator, extractString(record.lastUpdated))
    consumeGeminiMessage(accumulator, record)
  }

  return finalizeSession(accumulator, platform)
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
