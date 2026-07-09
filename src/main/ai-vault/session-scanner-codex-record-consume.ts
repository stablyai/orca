// Codex rollout JSONL line fold for AI Vault (session_meta / turn_context /
// response_item / event_msg / item_completed / token_count).

import {
  addPreviewContent,
  updateTimeline
} from './session-scanner-accumulator'
import { consumeCodexItemCompleted } from './session-scanner-codex-item-completed'
import type { CodexUsageSnapshot, SessionAccumulator } from './session-scanner-types'
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

export type CodexSessionParseState = {
  accumulator: SessionAccumulator
  previousTotals: CodexUsageSnapshot | null
  rejectedWorkerSession: boolean
  sawSessionMeta: boolean
  // Which source set the current title; an index-file title outranks the raw
  // first user prompt, so finalize must know whether 'meta' already won.
  titleSource: 'meta' | 'user' | null
}

export function consumeCodexRecordLine(state: CodexSessionParseState, line: string): void {
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

  // Why: Paginated history_mode persists TurnItems via item_completed instead of
  // legacy user_message/agent_message event_msg variants.
  if (payload.type === 'item_completed') {
    consumeCodexItemCompleted(state, payload, record.timestamp)
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
