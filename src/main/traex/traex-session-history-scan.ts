import { createInterface } from 'node:readline'
import { basename, dirname } from 'node:path'
import {
  createAccumulator,
  accumulatorSessionIdentity,
  cloneSessionAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from '../ai-vault/session-scanner-accumulator'
import { addSessionContent } from '../ai-vault/session-scanner-messages'
import { extractContentText } from '../ai-vault/session-scanner-text-normalization'
import {
  parseJsonObject,
  extractString,
  extractGitBranch,
  extractModel
} from '../ai-vault/session-scanner-values'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from '../ai-vault/session-scanner-types'
import type { TranscriptMessageSink } from '../ai-vault/transcripts/session-transcript-consumers'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { traexRecord } from './traex-protocol'

type TraexHistoryScanState = {
  accumulator: SessionAccumulator
  canonical: boolean
  paginated: boolean
  metadata: boolean
  excluded: boolean
  seen: Set<string>
}

function consumeTraexHistoryLine(state: TraexHistoryScanState, line: string): void {
  const record = parseJsonObject(line)
  if (!record || state.excluded) {
    return
  }
  const accumulator = state.accumulator
  updateTimeline(accumulator, record.timestamp)
  const payload = traexRecord(record.payload)
  if (record.type === 'session_meta' && !state.metadata) {
    state.metadata = true
    const source = payload.source
    state.excluded =
      source === 'internal' ||
      source === 'subagent' ||
      Object.keys(traexRecord(source)).some((key) => key === 'internal' || key === 'subagent') ||
      ['subagent', 'guardian_review', 'memory_consolidation'].includes(
        String(payload.thread_source)
      )
    accumulator.sessionId = extractString(payload.id) ?? accumulator.sessionId
    accumulator.cwd = extractString(payload.cwd)
    accumulator.branch = extractGitBranch(payload.git)
    accumulator.title = extractString(payload.name) ?? extractString(payload.title)
    state.canonical = payload.history_format === 'canonical_v1'
    state.paginated = payload.history_mode === 'paginated'
    return
  }
  if (record.type === 'turn_context') {
    accumulator.model = extractModel(payload) ?? accumulator.model
    return
  }
  if (record.type === 'event_msg' && payload.type === 'token_count') {
    const usage = traexRecord(traexRecord(payload.info).total_token_usage)
    if (typeof usage.total_tokens === 'number') {
      accumulator.totalTokens = usage.total_tokens
    }
    return
  }
  const consumeMessage = (value: unknown) => {
    const item = traexRecord(value)
    if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) {
      return
    }
    const metadata = traexRecord(item.internal_chat_message_metadata_passthrough)
    const contentMetadata = metadata.content_item_metadata
    if (
      item.role === 'user' &&
      Array.isArray(contentMetadata) &&
      contentMetadata.length > 0 &&
      !contentMetadata.some((entry) => traexRecord(traexRecord(entry).provenance).type === 'user')
    ) {
      return
    }
    const id = extractString(item.id)
    const key = id ? JSON.stringify([metadata.turn_id ?? payload.turn_id, id]) : null
    if (key && state.seen.has(key)) {
      return
    }
    if (key) {
      state.seen.add(key)
    }
    accumulator.messageCount++
    if (item.role === 'user') {
      const prompt = extractContentText(item.content)
      accumulator.fallbackTitle ??= prompt
      accumulator.lastUserPrompt = prompt
    }
    addSessionContent(accumulator, item.role, item.content, record.timestamp)
  }
  if (record.type === 'history_mutation' && Array.isArray(payload.items)) {
    payload.items.forEach(consumeMessage)
  } else if (!state.canonical && !state.paginated && record.type === 'response_item') {
    consumeMessage(payload)
  } else if (
    !state.canonical &&
    state.paginated &&
    record.type === 'event_msg' &&
    payload.type === 'item_completed'
  ) {
    const item = traexRecord(payload.item)
    const user = item.type === 'UserMessage' || item.type === 'user_message'
    if (user || item.type === 'AgentMessage' || item.type === 'agent_message') {
      consumeMessage({ ...item, type: 'message', role: user ? 'user' : 'assistant' })
    }
  }
}

function traexHistoryHome(filePath: string): string | null {
  let path = dirname(filePath)
  while (dirname(path) !== path) {
    if (basename(path) === 'sessions') {
      return dirname(path)
    }
    path = dirname(path)
  }
  return null
}

function resumeTraexHistoryState(state: TraexHistoryScanState): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeTraexHistoryLine(state, line),
    shouldStop: () => state.excluded,
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () =>
      resumeTraexHistoryState({
        ...state,
        accumulator: cloneSessionAccumulator(state.accumulator),
        seen: new Set(state.seen)
      }),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => {
      if (!state.metadata || state.excluded) {
        return null
      }
      const session = finalizeSession(cloneSessionAccumulator(state.accumulator), platform, options)
      const home = traexHistoryHome(state.accumulator.filePath)
      return session && home
        ? { ...session, accountHome: { variable: 'TRAECLI_HOME', path: home } }
        : session
    }
  }
}

export function createTraexSessionHistoryScan(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return resumeTraexHistoryState({
    accumulator: createAccumulator({
      agent: 'trae',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    canonical: false,
    paginated: false,
    metadata: false,
    excluded: false,
    seen: new Set()
  })
}

export async function parseTraexSessionHistory(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink
) {
  const state = createTraexSessionHistoryScan(file, messages)
  const stream = openTranscriptReadStream(file.path, {}, 'scan')
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      state.consumeLine(line)
      if (state.shouldStop?.()) {
        return null
      }
    }
    return await state.finalize(platform)
  } finally {
    lines.close()
    stream.destroy()
  }
}
