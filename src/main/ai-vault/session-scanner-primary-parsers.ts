import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

// Parse state kept resumable so the scan cache can append newly written
// transcript lines without re-reading the whole (potentially huge) file.
export type ClaudeSessionParseState = {
  accumulator: SessionAccumulator
  metaTitle: string | null
  generatedTitle: string | null
  firstUserTitle: string | null
}

export function createClaudeSessionParseState(file: FileWithMtime): ClaudeSessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'claude',
      file,
      sessionId: sessionIdFromFileName(file.path)
    }),
    metaTitle: null,
    generatedTitle: null,
    firstUserTitle: null
  }
}

export function cloneClaudeSessionParseState(
  state: ClaudeSessionParseState
): ClaudeSessionParseState {
  return {
    accumulator: {
      ...state.accumulator,
      previewMessages: [...state.accumulator.previewMessages]
    },
    metaTitle: state.metaTitle,
    generatedTitle: state.generatedTitle,
    firstUserTitle: state.firstUserTitle
  }
}

export function consumeClaudeSessionLine(state: ClaudeSessionParseState, line: string): void {
  const { accumulator } = state
  const record = parseJsonObject(line)
  if (!record) {
    return
  }

  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    accumulator.sessionId = record.sessionId.trim()
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  updateLatestLocation(accumulator, record)

  if (record.type === 'custom-title') {
    accumulator.title = normalizeTitleText(extractString(record.customTitle) ?? '')
    return
  }

  if (record.type === 'ai-title') {
    const title = normalizeTitleText(extractString(record.aiTitle) ?? '')
    if (title) {
      // Claude can revise generated names; AI Vault should mirror the current one.
      state.generatedTitle = title
    }
    return
  }

  if (record.type === 'agent-name' && !state.generatedTitle) {
    state.metaTitle ??= normalizeTitleText(extractString(record.agentName) ?? '')
    return
  }

  if (record.type === 'user') {
    accumulator.messageCount++
    const title = extractMessageText(record.message)
    addPreviewContent(accumulator, 'user', asRecord(record.message)?.content, record.timestamp)
    if (title) {
      // Meta prompts (injected context) only seed the last-resort title.
      if (record.isMeta === true) {
        state.metaTitle ??= title
      } else {
        state.firstUserTitle ??= title
      }
    }
    return
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

export function finalizeClaudeSessionParseState(
  state: ClaudeSessionParseState,
  platform: NodeJS.Platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  // Finalize a snapshot: the live state (and its preview array) may keep
  // accumulating appended lines after this session object is handed out.
  const snapshot = cloneClaudeSessionParseState(state)
  // Why: a user-set custom-title (accumulator.title) wins, but Claude's generated
  // session name (ai-title) should outrank the raw first prompt when present.
  snapshot.accumulator.fallbackTitle =
    snapshot.generatedTitle ?? snapshot.firstUserTitle ?? snapshot.metaTitle
  return finalizeSession(snapshot.accumulator, platform, options)
}

export function createClaudeSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return claudeResumeStateFromParseState(createClaudeSessionParseState(file))
}

function claudeResumeStateFromParseState(
  state: ClaudeSessionParseState
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeClaudeSessionLine(state, line),
    clone: () => claudeResumeStateFromParseState(cloneClaudeSessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeClaudeSessionParseState(state, platform, options)
  }
}

export async function parseClaudeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseClaudeSessionLines({ file, lines, platform })
}

export async function parseClaudeSessionContent(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  return parseClaudeSessionLines({
    file,
    lines: content.split(/\r?\n/),
    platform,
    options
  })
}

async function parseClaudeSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
}): Promise<AiVaultSession | null> {
  const state = createClaudeSessionParseState(args.file)
  for await (const line of args.lines) {
    consumeClaudeSessionLine(state, line)
  }
  return finalizeClaudeSessionParseState(state, args.platform, args.options)
}

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
  options: ParserSessionOptions = {}
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
  options: ParserSessionOptions = {}
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
  options?: ParserSessionOptions
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
