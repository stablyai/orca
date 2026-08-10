import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { normalizePromptField } from '../../shared/agent-status-field-normalization'
import {
  addPreviewContent,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import { readRolloutSessionIndexTitle } from './session-scanner-rollout-title-index'
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
import { remoteSessionContentLines } from './remote-session-content-lines'
export type RolloutSessionAgent = Extract<AiVaultAgent, 'codex' | 'trae'>
type RolloutSessionParseState = {
  accumulator: SessionAccumulator
  previousTotals: CodexUsageSnapshot | null
  rejectedWorkerSession: boolean
  sawSessionMeta: boolean
  titleSource: 'meta' | 'user' | null
}
export async function parseRolloutSessionFile(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  platform: NodeJS.Platform
  sessionHome: string | null
  executionHostId?: ExecutionHostId
}): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: createReadStream(args.file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return parseRolloutSessionLines({
    ...args,
    lines,
    titleReader: (sessionId) =>
      readRolloutSessionFileIndexTitle(args.file, args.sessionHome, sessionId)
  })
}
export async function parseRolloutSessionContent(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  content: string
  platform: NodeJS.Platform
  sessionHome: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  return parseRolloutSessionLines({
    ...args,
    lines: remoteSessionContentLines(args.content, args.signal),
    titleReader: args.readIndexedTitle
  })
}
export function createRolloutSessionResumeState(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  sessionHome: string | null
}): ResumableSessionParseState {
  return rolloutResumeStateFromParseState(
    createRolloutParseState(args.agent, args.file),
    args.agent,
    args.sessionHome,
    (sessionId) => readRolloutSessionFileIndexTitle(args.file, args.sessionHome, sessionId)
  )
}
function createRolloutParseState(
  agent: RolloutSessionAgent,
  file: FileWithMtime
): RolloutSessionParseState {
  return {
    accumulator: createAccumulator({ agent, file, sessionId: sessionIdFromFileName(file.path) }),
    previousTotals: null,
    rejectedWorkerSession: false,
    sawSessionMeta: false,
    titleSource: null
  }
}
function cloneRolloutParseState(state: RolloutSessionParseState): RolloutSessionParseState {
  return { ...state, accumulator: cloneSessionAccumulator(state.accumulator) }
}
function consumeRolloutRecordLine(state: RolloutSessionParseState, line: string): void {
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
    if (isRolloutWorkerSession(payload)) {
      state.rejectedWorkerSession = true
      return
    }
    state.sawSessionMeta = true
    const sessionId = extractString(payload.id)
    accumulator.sessionId = sessionId || accumulator.sessionId
    const metadataTitle = extractRolloutSessionMetadataTitle(payload)
    if (metadataTitle) {
      accumulator.title = metadataTitle
      state.titleSource = 'meta'
    }
    const cwd = extractString(payload.cwd)
    accumulator.cwd = cwd || accumulator.cwd
    accumulator.branch = extractGitBranch(payload.git) ?? accumulator.branch
    return
  }
  if (record.type === 'turn_context' && payload) {
    const cwd = extractString(payload.cwd)
    accumulator.cwd = cwd || accumulator.cwd
    const model = extractModel(payload)
    accumulator.model = model || accumulator.model
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
    const prompt = normalizePromptField(payload.message)
    if (prompt) {
      accumulator.lastUserPrompt = prompt
    }
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
  accumulator.model = model || accumulator.model
}
async function finalizeRolloutParseState(
  state: RolloutSessionParseState,
  agent: RolloutSessionAgent,
  sessionHome: string | null,
  platform: NodeJS.Platform,
  args: {
    titleReader?: (sessionId: string) => Promise<string | null>
    executionHostId?: ExecutionHostId
    executionHostPlatform?: NodeJS.Platform | null
  }
): Promise<AiVaultSession | null> {
  if (state.rejectedWorkerSession) {
    return null
  }
  const snapshot = cloneRolloutParseState(state)
  if (snapshot.sawSessionMeta && snapshot.titleSource !== 'meta') {
    const indexedTitle = await args.titleReader?.(snapshot.accumulator.sessionId)
    if (indexedTitle) {
      snapshot.accumulator.title = indexedTitle
    }
  }
  return finalizeSession(snapshot.accumulator, platform, {
    codexHome: agent === 'codex' ? sessionHome : null,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}
function rolloutResumeStateFromParseState(
  state: RolloutSessionParseState,
  agent: RolloutSessionAgent,
  sessionHome: string | null,
  titleReader: (sessionId: string) => Promise<string | null>
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeRolloutRecordLine(state, line),
    clone: () =>
      rolloutResumeStateFromParseState(
        cloneRolloutParseState(state),
        agent,
        sessionHome,
        titleReader
      ),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options?: ResumableParseFinalizeOptions) =>
      finalizeRolloutParseState(state, agent, sessionHome, platform, { titleReader, ...options })
  }
}
async function parseRolloutSessionLines(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  sessionHome: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  titleReader?: (sessionId: string) => Promise<string | null>
}): Promise<AiVaultSession | null> {
  const state = createRolloutParseState(args.agent, args.file)
  for await (const line of args.lines) {
    consumeRolloutRecordLine(state, line)
    if (state.rejectedWorkerSession) {
      return null
    }
  }
  return finalizeRolloutParseState(state, args.agent, args.sessionHome, args.platform, {
    titleReader: args.titleReader,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}
function isRolloutWorkerSession(payload: Record<string, unknown>): boolean {
  const threadSource = extractString(payload.thread_source) ?? extractString(payload.threadSource)
  if (threadSource) {
    return threadSource.toLowerCase() !== 'user'
  }
  const source = asRecord(payload.source)
  return Boolean(asRecord(source?.subagent))
}
function extractRolloutSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}

function readRolloutSessionFileIndexTitle(
  file: FileWithMtime,
  sessionHome: string | null,
  sessionId: string
): Promise<string | null> {
  return readRolloutSessionIndexTitle({ sessionFilePath: file.path, sessionHome, sessionId })
}
