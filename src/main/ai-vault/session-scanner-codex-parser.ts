import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  addPreviewContent,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import type {
  CodexUsageSnapshot,
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  addCodexUsage,
  asRecord,
  extractContentText,
  extractGitBranch,
  extractModel,
  extractString,
  normalizeCodexUsage,
  normalizeTitleText,
  parseJsonObject,
  subtractCodexUsage
} from './session-scanner-values'

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codexHome: string | null = null,
  executionHostId?: ExecutionHostId
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  return parseCodexSessionLines({
    file,
    lines,
    platform,
    codexHome,
    executionHostId,
    titleReader: (sessionId) => readCodexSessionIndexTitle(file.path, codexHome, sessionId)
  })
}

export async function parseCodexSessionContent(args: {
  file: FileWithMtime
  content: string
  platform?: NodeJS.Platform
  codexHome?: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
}): Promise<AiVaultSession | null> {
  return parseCodexSessionLines({
    file: args.file,
    lines: args.content.split(/\r?\n/),
    platform: args.platform ?? process.platform,
    codexHome: args.codexHome ?? null,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform,
    titleReader: args.readIndexedTitle
  })
}

type CodexSessionParseState = {
  accumulator: SessionAccumulator
  previousTotals: CodexUsageSnapshot | null
  rejectedWorkerSession: boolean
  sawSessionMeta: boolean
  // Which source set the current title; an index-file title outranks the raw
  // first user prompt, so finalize must know whether 'meta' already won.
  titleSource: 'meta' | 'user' | null
}

function createCodexParseState(file: FileWithMtime): CodexSessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'codex',
      file,
      sessionId: sessionIdFromFileName(file.path)
    }),
    previousTotals: null,
    rejectedWorkerSession: false,
    sawSessionMeta: false,
    titleSource: null
  }
}

function cloneCodexParseState(state: CodexSessionParseState): CodexSessionParseState {
  return {
    // previousTotals snapshots are replaced, never mutated, so sharing is safe.
    ...state,
    accumulator: cloneSessionAccumulator(state.accumulator)
  }
}

function consumeCodexRecordLine(state: CodexSessionParseState, line: string): void {
  if (state.rejectedWorkerSession) {
    return
  }
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  const { accumulator } = state

  updateTimeline(accumulator, extractString(record.timestamp))

  const payload = asRecord(record.payload)
  if (record.type === 'session_meta' && payload) {
    if (isCodexWorkerSession(payload)) {
      // Why: Codex writes internal worker/sub-agent transcripts into the same
      // history tree; AI Vault should show user-started sessions only.
      state.rejectedWorkerSession = true
      return
    }
    state.sawSessionMeta = true
    const sessionId = extractString(payload.id)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    const metadataTitle = extractCodexSessionMetadataTitle(payload)
    if (metadataTitle) {
      accumulator.title = metadataTitle
      state.titleSource = 'meta'
    }
    const cwd = extractString(payload.cwd)
    if (cwd) {
      accumulator.cwd = cwd
    }
    accumulator.branch = extractGitBranch(payload.git) ?? accumulator.branch
    return
  }

  if (record.type === 'turn_context' && payload) {
    const cwd = extractString(payload.cwd)
    if (cwd) {
      accumulator.cwd = cwd
    }
    const model = extractModel(payload)
    if (model) {
      accumulator.model = model
    }
    return
  }

  if (!payload) {
    return
  }

  if (record.type === 'response_item' && payload.type === 'message') {
    accumulator.messageCount++
    if (payload.role === 'user' && !accumulator.title) {
      accumulator.title = extractContentText(payload.content)
      state.titleSource = accumulator.title ? 'user' : state.titleSource
    }
    addPreviewContent(
      accumulator,
      payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : 'unknown',
      payload.content,
      record.timestamp
    )
    return
  }

  if (record.type !== 'event_msg') {
    return
  }

  if (payload.type === 'user_message') {
    accumulator.messageCount++
    if (!accumulator.title) {
      accumulator.title = extractContentText(payload.message)
      state.titleSource = accumulator.title ? 'user' : state.titleSource
    }
    addPreviewContent(accumulator, 'user', payload.message, record.timestamp)
    return
  }

  if (payload.type === 'agent_message') {
    accumulator.messageCount++
    addPreviewContent(accumulator, 'assistant', payload.message, record.timestamp)
    return
  }

  if (payload.type !== 'token_count') {
    return
  }

  const info = asRecord(payload.info)
  if (!info) {
    return
  }
  const totalUsage = normalizeCodexUsage(info.total_token_usage)
  const lastUsage = normalizeCodexUsage(info.last_token_usage)
  let delta: CodexUsageSnapshot | null = null
  if (totalUsage) {
    delta = subtractCodexUsage(totalUsage, state.previousTotals)
    state.previousTotals = totalUsage
  } else if (lastUsage) {
    delta = lastUsage
    state.previousTotals = state.previousTotals
      ? addCodexUsage(state.previousTotals, lastUsage)
      : lastUsage
  }
  if (delta) {
    accumulator.totalTokens += delta.totalTokens
  }
  const model = extractModel(payload)
  if (model) {
    accumulator.model = model
  }
}

async function finalizeCodexParseState(
  state: CodexSessionParseState,
  platform: NodeJS.Platform,
  args: {
    codexHome: string | null
    titleReader?: (sessionId: string) => Promise<string | null>
    executionHostId?: ExecutionHostId
    executionHostPlatform?: NodeJS.Platform | null
  }
): Promise<AiVaultSession | null> {
  if (state.rejectedWorkerSession) {
    return null
  }
  // Finalize a snapshot: the live state keeps accumulating appended lines.
  const snapshot = cloneCodexParseState(state)
  // Why: Codex names threads lazily in session_index.jsonl, so the lookup runs
  // per finalize (the index read is signature-cached) — a title that appears
  // after the transcript was first parsed must still replace the raw prompt.
  if (snapshot.sawSessionMeta && snapshot.titleSource !== 'meta') {
    const indexedTitle = await args.titleReader?.(snapshot.accumulator.sessionId)
    if (indexedTitle) {
      snapshot.accumulator.title = indexedTitle
    }
  }
  return finalizeSession(snapshot.accumulator, platform, {
    codexHome: args.codexHome,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}

export function createCodexSessionResumeState(
  file: FileWithMtime,
  codexHome: string | null
): ResumableSessionParseState {
  return codexResumeStateFromParseState(createCodexParseState(file), codexHome, (sessionId) =>
    readCodexSessionIndexTitle(file.path, codexHome, sessionId)
  )
}

function codexResumeStateFromParseState(
  state: CodexSessionParseState,
  codexHome: string | null,
  titleReader: (sessionId: string) => Promise<string | null>
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeCodexRecordLine(state, line),
    clone: () =>
      codexResumeStateFromParseState(cloneCodexParseState(state), codexHome, titleReader),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options?: ResumableParseFinalizeOptions) =>
      finalizeCodexParseState(state, platform, { codexHome, titleReader, ...options })
  }
}

async function parseCodexSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  codexHome: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  titleReader?: (sessionId: string) => Promise<string | null>
}): Promise<AiVaultSession | null> {
  const state = createCodexParseState(args.file)
  for await (const line of args.lines) {
    consumeCodexRecordLine(state, line)
    if (state.rejectedWorkerSession) {
      // Worker transcripts are excluded outright; stop reading early.
      return null
    }
  }
  return finalizeCodexParseState(state, args.platform, {
    codexHome: args.codexHome,
    titleReader: args.titleReader,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}

function extractCodexThreadSource(payload: Record<string, unknown>): string | null {
  return extractString(payload.thread_source) ?? extractString(payload.threadSource)
}

function isCodexWorkerSession(payload: Record<string, unknown>): boolean {
  const threadSource = extractCodexThreadSource(payload)
  if (threadSource) {
    return threadSource.toLowerCase() !== 'user'
  }

  const source = asRecord(payload.source)
  return Boolean(asRecord(source?.subagent))
}

function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
