import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
  extractContentText,
  extractMessageText,
  extractString,
  firstString,
  parseJsonObject,
  readJsonObjectIfExists,
  tokenTotal
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

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

// Agents whose transcripts are append-only message-graph JSONL (session +
// model_change + message records). OMP is a Pi fork and shares the format.
export type MessageGraphAgent = 'openclaw' | 'pi' | 'omp'

export async function parseMessageGraphSessionFile(
  agent: MessageGraphAgent,
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseMessageGraphSessionLines({ agent, file, lines, platform })
}

export async function parseMessageGraphSessionContent(
  agent: MessageGraphAgent,
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionLines({
    agent,
    file,
    lines: content.split(/\r?\n/),
    platform,
    options
  })
}

function consumeMessageGraphRecordLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  if (record.type === 'session') {
    const sessionId = extractString(record.id)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    accumulator.cwd = extractString(record.cwd) ?? accumulator.cwd
    return
  }
  if (record.type === 'model_change') {
    // Pi writes `modelId`; OMP writes `model`. Prefer either so an in-progress
    // session shows its model before the first assistant reply lands.
    accumulator.model =
      extractString(record.modelId) ?? extractString(record.model) ?? accumulator.model
    return
  }
  if (record.type !== 'message') {
    return
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

export function createMessageGraphSessionResumeState(
  agent: MessageGraphAgent,
  file: FileWithMtime
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({ agent, file, sessionId: sessionIdFromFileName(file.path) }),
    consumeMessageGraphRecordLine
  )
}

async function parseMessageGraphSessionLines(args: {
  agent: MessageGraphAgent
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createMessageGraphSessionResumeState(args.agent, args.file)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}
