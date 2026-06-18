import { createReadStream } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createInterface } from 'readline'
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
  extractContentText,
  extractMessageText,
  extractPreviewContentText,
  extractString,
  firstString,
  normalizeTitleText,
  parseJsonObject,
  readJsonObjectIfExists,
  tokenTotal
} from './session-scanner-values'

export async function parseRovoSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const metadata = asRecord(JSON.parse(await readFile(file.path, 'utf-8')) as unknown)
  if (!metadata) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'rovo',
    file,
    sessionId: basename(dirname(file.path))
  })
  accumulator.title = firstString(metadata, ['title', 'name', 'summary'])
  accumulator.cwd = firstString(metadata, [
    'workspace_path',
    'workspacePath',
    'workspace',
    'cwd',
    'working_directory',
    'workingDirectory',
    'project_path',
    'projectPath'
  ])
  updateTimeline(
    accumulator,
    extractString(metadata.created_at) ?? extractString(metadata.createdAt)
  )
  updateTimeline(
    accumulator,
    extractString(metadata.updated_at) ?? extractString(metadata.updatedAt)
  )

  const contextPath = join(dirname(file.path), 'session_context.json')
  const context = await readJsonObjectIfExists(contextPath)
  if (context) {
    consumeRovoSessionContext(accumulator, context)
  }

  return finalizeSession(accumulator, platform)
}

export function consumeRovoSessionContext(
  accumulator: SessionAccumulator,
  context: Record<string, unknown>
): void {
  for (const message of arrayValue(context.messages)) {
    const record = asRecord(message)
    const role = extractString(record?.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      updateTimeline(accumulator, extractString(record?.timestamp))
      if (role === 'user') {
        accumulator.title ??= extractContentText(record?.content)
      }
      addPreviewContent(accumulator, role, record?.content, record?.timestamp)
    }
  }

  for (const historyEntry of arrayValue(context.message_history)) {
    consumeRovoHistoryEntry(accumulator, asRecord(historyEntry))
  }
}

export function consumeRovoHistoryEntry(
  accumulator: SessionAccumulator,
  record: Record<string, unknown> | null
): void {
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  const role = extractString(record.role) ?? rovoRoleFromKind(record.kind)
  if (role !== 'user' && role !== 'assistant') {
    return
  }
  const text = rovoPartsText(arrayValue(record.parts), role)
  if (!text) {
    return
  }
  accumulator.messageCount++
  if (role === 'user') {
    accumulator.title ??= text
  }
  addPreviewMessage(accumulator, {
    role,
    text,
    timestamp: record.timestamp
  })
}

export function rovoRoleFromKind(value: unknown): 'user' | 'assistant' | null {
  if (value === 'request') {
    return 'user'
  }
  if (value === 'response') {
    return 'assistant'
  }
  return null
}

export function rovoPartsText(parts: unknown[], role: 'user' | 'assistant'): string | null {
  const textParts: string[] = []
  for (const part of parts) {
    const record = asRecord(part)
    if (!record) {
      continue
    }
    const kind = extractString(record.part_kind)
    if (role === 'user' && kind !== 'user-prompt' && kind !== 'text') {
      continue
    }
    if (role === 'assistant' && kind !== 'text') {
      continue
    }
    const text =
      typeof record.content === 'string'
        ? record.content
        : typeof record.text === 'string'
          ? record.text
          : null
    if (text !== null) {
      textParts.push(text)
    }
  }
  return extractContentText(textParts)
}

export async function parseMessageGraphSessionFile(
  agent: 'openclaw' | 'pi',
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent,
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
    if (record.type === 'session') {
      const sessionId = extractString(record.id)
      if (sessionId) {
        accumulator.sessionId = sessionId
      }
      accumulator.cwd = extractString(record.cwd) ?? accumulator.cwd
      continue
    }
    if (record.type === 'model_change') {
      accumulator.model = extractString(record.modelId) ?? accumulator.model
      continue
    }
    if (record.type !== 'message') {
      continue
    }
    const message = asRecord(record.message)
    const role = extractString(message?.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      if (role === 'user') {
        accumulator.title ??= extractMessageText(message)
      } else {
        accumulator.model = extractString(message?.model) ?? accumulator.model
        accumulator.totalTokens += tokenTotal(message?.usage)
      }
      addPreviewContent(accumulator, role, message?.content, record.timestamp)
    }
  }

  return finalizeSession(accumulator, platform)
}

export async function parseDroidSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'droid',
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
    updateTimeline(accumulator, record.timestamp)
    if (record.type === 'session_start') {
      accumulator.sessionId = extractString(record.id) ?? accumulator.sessionId
      accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
      accumulator.cwd = extractString(record.cwd) ?? accumulator.cwd
      continue
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
      const role = extractString(record.role) ?? extractString(asRecord(record.message)?.role)
      if (role === 'user' || role === 'assistant') {
        accumulator.messageCount++
        if (role === 'user') {
          accumulator.title ??=
            normalizeTitleText(extractString(record.text) ?? '') ||
            extractMessageText(asRecord(record.message))
        }
        addPreviewMessage(accumulator, {
          role,
          text:
            extractString(record.text) ??
            extractPreviewContentText(asRecord(record.message)?.content),
          timestamp: record.timestamp
        })
      }
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
  return finalizeSession(accumulator, platform)
}
