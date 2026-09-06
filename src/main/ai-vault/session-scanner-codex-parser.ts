import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'
import {
  applyCodexStateThreadFallback,
  readCodexStateThreadMetadata,
  type CodexStateThreadReader
} from './session-scanner-codex-state-threads'
import {
  extractCodexSessionMetadataTitle,
  isCodexWorkerSession
} from './session-scanner-codex-session-meta'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
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
import { consumeCodexTokenCount } from './session-scanner-codex-token-count'
import type {
  CodexUsageSnapshot,
  FileWithMtime,
  ResumableParseFinalizeOptions,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  asRecord,
  extractGitBranch,
  extractModel,
  extractString,
  parseJsonObject
} from './session-scanner-values'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { readCodexTimelineOnlyRecord } from './session-scanner-codex-record-fast-path'
import { captureCodexToolRecord } from './session-search-codex-tool-records'
import { isSessionSearchCaptureActive } from './session-search-capture'

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codexHome: string | null = null,
  executionHostId?: ExecutionHostId
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
    titleReader: (sessionId) => readCodexSessionIndexTitle(file.path, codexHome, sessionId),
    stateThreadReader: (threadId) => readCodexStateThreadMetadata(codexHome, threadId)
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
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  return parseCodexSessionLines({
    file: args.file,
    lines: remoteSessionContentLines(args.content, args.signal),
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
  historyMode: string | null
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

  captureCodexToolRecord(record.type, payload, record.timestamp, state.historyMode)

  if (record.type === 'response_item' && payload.type === 'message') {
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

  if (payload.type === 'token_count') {
    state.previousTotals = consumeCodexTokenCount(accumulator, payload, state.previousTotals)
  }
}

async function finalizeCodexParseState(
  state: CodexSessionParseState,
  platform: NodeJS.Platform,
  args: {
    codexHome: string | null
    titleReader?: (sessionId: string) => Promise<string | null>
    stateThreadReader?: CodexStateThreadReader
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
  await applyCodexStateThreadFallback(snapshot.accumulator, args.stateThreadReader)
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
  return codexResumeStateFromParseState(
    createCodexParseState(file),
    codexHome,
    (sessionId) => readCodexSessionIndexTitle(file.path, codexHome, sessionId),
    (threadId) => readCodexStateThreadMetadata(codexHome, threadId)
  )
}

function codexResumeStateFromParseState(
  state: CodexSessionParseState,
  codexHome: string | null,
  titleReader: (sessionId: string) => Promise<string | null>,
  stateThreadReader: CodexStateThreadReader
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeCodexRecordLine(state, line),
    consumeLineBytes: (line) => {
      // The prefix fast path skips exactly the tool records the search index wants.
      const timelineOnlyRecord = isSessionSearchCaptureActive()
        ? null
        : readCodexTimelineOnlyRecord(line)
      if (timelineOnlyRecord) {
        updateTimeline(state.accumulator, timelineOnlyRecord.timestamp)
      } else {
        consumeCodexRecordLine(state, line.toString('utf8'))
      }
    },
    shouldStop: () => state.rejectedWorkerSession,
    clone: () =>
      codexResumeStateFromParseState(
        cloneCodexParseState(state),
        codexHome,
        titleReader,
        stateThreadReader
      ),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options?: ResumableParseFinalizeOptions) =>
      finalizeCodexParseState(state, platform, {
        codexHome,
        titleReader,
        stateThreadReader,
        ...options
      })
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
  stateThreadReader?: CodexStateThreadReader
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
    stateThreadReader: args.stateThreadReader,
    executionHostId: args.executionHostId,
    executionHostPlatform: args.executionHostPlatform
  })
}
