import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  accumulatorSessionIdentity,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import {
  consumeCodexCompletedMessage,
  consumeCodexLegacyEventMessage,
  consumeCodexResponseMessage
} from './session-scanner-codex-message-records'
import type {
  CodexUsageSnapshot,
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addCodexUsage,
  asRecord,
  extractGitBranch,
  extractModel,
  extractString,
  normalizeCodexUsage,
  parseJsonObject,
  subtractCodexUsage
} from './session-scanner-values'
import { readCodexTimelineOnlyRecord } from './session-scanner-codex-record-fast-path'
import { extractCodexSessionMetadataTitle } from './session-scanner-codex-session-meta'
import {
  readCodexNonUserOrigin,
  type CodexNonUserOrigin
} from './session-scanner-codex-non-user-origin'

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codexHome: string | null = null,
  executionHostId?: ExecutionHostId,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })

  return parseCodexSessionLines({
    file,
    lines,
    platform,
    codexHome,
    executionHostId,
    messages,
    titleReader: (sessionId) => readCodexSessionIndexTitle(file.path, codexHome, sessionId)
  })
}

type CodexSessionParseState = {
  accumulator: SessionAccumulator
  previousTotals: CodexUsageSnapshot | null
  // Non-user origin excludes worker and internal transcripts stored alongside user sessions.
  nonUserOrigin: CodexNonUserOrigin | null
  sawSessionMeta: boolean
  historyMode: string | null
  // Metadata titles outrank indexed titles, which outrank raw user prompts.
  titleSource: 'meta' | 'user' | null
}

function createCodexParseState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): CodexSessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'codex',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    previousTotals: null,
    nonUserOrigin: null,
    sawSessionMeta: false,
    historyMode: null,
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
  if (state.nonUserOrigin) {
    return
  }
  const record = parseJsonObject(line)
  if (!record) {
    return
  }
  const { accumulator } = state

  updateTimeline(accumulator, extractString(record.timestamp))

  const payload = asRecord(record.payload)
  // Forks may copy parent metadata later; the first session_meta defines this thread.
  if (record.type === 'session_meta' && payload && !state.sawSessionMeta) {
    state.nonUserOrigin = readCodexNonUserOrigin(payload)
    if (state.nonUserOrigin) {
      return
    }
    state.sawSessionMeta = true
    state.historyMode = extractString(payload.history_mode)
    const sessionId = extractString(payload.id)
    if (sessionId) {
      accumulator.sessionId = sessionId
    }
    const metadataTitle = extractCodexSessionMetadataTitle(payload)
    if (metadataTitle) {
      accumulator.title = metadataTitle
      state.titleSource = 'meta'
    }
    accumulator.cwd = extractString(payload.cwd) ?? accumulator.cwd
    accumulator.branch = extractGitBranch(payload.git) ?? accumulator.branch
    return
  }

  if (record.type === 'turn_context' && payload) {
    accumulator.cwd = extractString(payload.cwd) ?? accumulator.cwd
    const model = extractModel(payload)
    if (model) {
      accumulator.model = model
    }
    return
  }

  if (!payload) {
    return
  }

  if (record.type === 'response_item') {
    if (state.historyMode === 'paginated') {
      return
    }
    if (consumeCodexResponseMessage(accumulator, payload, record.timestamp)) {
      state.titleSource = 'user'
    }
    return
  }

  if (record.type !== 'event_msg') {
    return
  }

  if (state.historyMode === 'paginated' && payload.type === 'item_completed') {
    if (consumeCodexCompletedMessage(accumulator, payload, record.timestamp)) {
      state.titleSource = 'user'
    }
    return
  }

  if (payload.type === 'user_message' || payload.type === 'agent_message') {
    if (consumeCodexLegacyEventMessage(accumulator, payload, record.timestamp)) {
      state.titleSource = 'user'
    }
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
  if (state.nonUserOrigin) {
    return null
  }
  // Finalize a snapshot: the live state keeps accumulating appended lines.
  const snapshot = cloneCodexParseState(state)
  // Recheck the signature-cached index: a title can arrive after the transcript stops growing.
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
  codexHome: string | null,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return codexResumeStateFromParseState(
    createCodexParseState(file, messages),
    codexHome,
    (sessionId) => readCodexSessionIndexTitle(file.path, codexHome, sessionId)
  )
}

function codexResumeStateFromParseState(
  state: CodexSessionParseState,
  codexHome: string | null,
  titleReader: (sessionId: string) => Promise<string | null>
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeCodexRecordLine(state, line),
    consumeLineBytes: (line) => {
      const timelineOnlyRecord = readCodexTimelineOnlyRecord(
        line,
        state.accumulator.messages.active && state.historyMode !== 'paginated'
      )
      if (timelineOnlyRecord) {
        updateTimeline(state.accumulator, timelineOnlyRecord.timestamp)
      } else {
        consumeCodexRecordLine(state, line.toString('utf8'))
      }
    },
    shouldStop: () => state.nonUserOrigin !== null,
    identity: () => accumulatorSessionIdentity(state.accumulator),
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
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createCodexParseState(args.file, args.messages)
  for await (const line of args.lines) {
    consumeCodexRecordLine(state, line)
    if (state.nonUserOrigin) {
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
