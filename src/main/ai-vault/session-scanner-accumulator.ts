import { basename, extname } from 'node:path'
import {
  aiVaultAgentLabel,
  buildAiVaultResumeCommand,
  type AiVaultAgent,
  type AiVaultSession,
  type AiVaultSessionPreviewMessage
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import {
  extractPreviewContentText,
  extractString,
  extractUserPromptText,
  normalizePreviewText,
  normalizeUserPromptText,
  timestampMs
} from './session-scanner-values'

const SESSION_PREVIEW_MESSAGE_LIMIT = 5
// Per-session cap on retained user prompts (Prompt History). Bounds payload/memory
// while keeping far more than the 5-message rolling preview.
const USER_PROMPT_HISTORY_LIMIT = 25

export function createAccumulator(args: {
  agent: AiVaultAgent
  file: FileWithMtime
  sessionId: string
}): SessionAccumulator {
  return {
    agent: args.agent,
    sessionId: args.sessionId,
    title: null,
    fallbackTitle: null,
    cwd: null,
    branch: null,
    model: null,
    filePath: args.file.path,
    createdAt: null,
    updatedAt: null,
    modifiedAt: args.file.modifiedAt,
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    userPrompts: [],
    latestTimestampMs: 0
  }
}

export function cloneSessionAccumulator(accumulator: SessionAccumulator): SessionAccumulator {
  return {
    ...accumulator,
    previewMessages: [...accumulator.previewMessages],
    // Deep-copy so the resumable parse cache can't corrupt a handed-out snapshot.
    userPrompts: [...accumulator.userPrompts]
  }
}

// Resumable fold for parsers whose only parse state is the accumulator itself
// (cursor, copilot, droid, openclaw/pi, gemini-jsonl). Parsers with extra
// closure state (claude, codex) build their own ResumableSessionParseState.
export function accumulatorFoldResumeState(
  accumulator: SessionAccumulator,
  consumeRecordLine: (accumulator: SessionAccumulator, line: string) => void
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeRecordLine(accumulator, line),
    clone: () =>
      accumulatorFoldResumeState(cloneSessionAccumulator(accumulator), consumeRecordLine),
    touchFile: (file) => {
      accumulator.modifiedAt = file.modifiedAt
    },
    // Finalize a snapshot: the live accumulator (and its preview array) keeps
    // accumulating appended lines after this session object is handed out.
    finalize: (platform, options) =>
      finalizeSession(cloneSessionAccumulator(accumulator), platform, options)
  }
}

export function finalizeSession(
  accumulator: SessionAccumulator,
  platform: NodeJS.Platform,
  options: {
    codexHome?: string | null
    executionHostId?: ExecutionHostId
    executionHostPlatform?: NodeJS.Platform | null
  } = {}
): AiVaultSession | null {
  const sessionId = accumulator.sessionId.trim()
  if (!sessionId) {
    return null
  }
  const title =
    accumulator.title ||
    accumulator.fallbackTitle ||
    `${aiVaultAgentLabel(accumulator.agent)} ${sessionId.slice(0, 8)}`

  const executionHostId = options.executionHostId ?? LOCAL_EXECUTION_HOST_ID

  return {
    id: `${executionHostId}:${accumulator.agent}:${sessionId}:${accumulator.filePath}`,
    executionHostId,
    ...(options.executionHostPlatform
      ? { executionHostPlatform: options.executionHostPlatform }
      : {}),
    agent: accumulator.agent,
    sessionId,
    title,
    cwd: accumulator.cwd,
    branch: accumulator.branch,
    model: accumulator.model,
    filePath: accumulator.filePath,
    codexHome: accumulator.agent === 'codex' ? (options.codexHome ?? null) : null,
    createdAt: accumulator.createdAt,
    updatedAt: accumulator.updatedAt,
    modifiedAt: accumulator.modifiedAt,
    messageCount: accumulator.messageCount,
    totalTokens: accumulator.totalTokens,
    previewMessages: accumulator.previewMessages,
    userPrompts: accumulator.userPrompts,
    resumeCommand: buildAiVaultResumeCommand({
      agent: accumulator.agent,
      sessionId,
      resumeFilePath: accumulator.filePath,
      cwd: accumulator.cwd,
      platform,
      codexHome: options.codexHome
    })
  }
}

export function updateTimeline(accumulator: SessionAccumulator, timestamp: unknown): void {
  const parsed = timestampMs(timestamp)
  if (!Number.isFinite(parsed)) {
    return
  }
  const iso = new Date(parsed).toISOString()
  if (!accumulator.createdAt || parsed < Date.parse(accumulator.createdAt)) {
    accumulator.createdAt = iso
  }
  if (!accumulator.updatedAt || parsed >= Date.parse(accumulator.updatedAt)) {
    accumulator.updatedAt = iso
    accumulator.latestTimestampMs = parsed
  }
}

export function addPreviewMessage(
  accumulator: SessionAccumulator,
  args: {
    role: AiVaultSessionPreviewMessage['role']
    text: string | null
    timestamp?: unknown
    // Full-fidelity user-prompt text for Prompt History; falls back to `text`.
    fullPromptText?: string | null
    // True when a role:'user' record is not a typed prompt (tool result, or
    // injected/meta context) and must be kept out of Prompt History.
    excludeFromPromptHistory?: boolean
  }
): void {
  const timestamp = timestampIso(args.timestamp)
  const previewText = normalizePreviewText(args.text ?? '')
  if (previewText) {
    accumulator.previewMessages.push({ role: args.role, text: previewText, timestamp })
    if (accumulator.previewMessages.length > SESSION_PREVIEW_MESSAGE_LIMIT) {
      accumulator.previewMessages.shift()
    }
  }
  // Retain the full run of genuine user prompts (excluding tool results and the
  // preview's 220-char truncation) so Prompt History can copy them back verbatim.
  if (args.role === 'user' && !args.excludeFromPromptHistory) {
    const promptText = normalizeUserPromptText(args.fullPromptText ?? args.text ?? '')
    if (promptText) {
      accumulator.userPrompts.push({ text: promptText, timestamp })
      if (accumulator.userPrompts.length > USER_PROMPT_HISTORY_LIMIT) {
        accumulator.userPrompts.shift()
      }
    }
  }
}

// Claude and similar agents store tool results as role:'user' records.
function isToolResultBlock(block: unknown): boolean {
  return (
    block != null &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_result'
  )
}

// A user turn that is nothing but tool results (no typed text) is not a prompt.
function isToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every(isToolResultBlock)
}

// Drop tool_result blocks so a mixed turn (tool output + typed text) contributes
// only the user's text to Prompt History, never the tool output.
function stripToolResultBlocks(content: unknown): unknown {
  return Array.isArray(content) ? content.filter((block) => !isToolResultBlock(block)) : content
}

export function addPreviewContent(
  accumulator: SessionAccumulator,
  role: AiVaultSessionPreviewMessage['role'],
  content: unknown,
  timestamp?: unknown,
  options?: { excludeFromPromptHistory?: boolean }
): void {
  const excludeFromPromptHistory =
    options?.excludeFromPromptHistory === true || (role === 'user' && isToolResultContent(content))
  addPreviewMessage(accumulator, {
    role,
    text: extractPreviewContentText(content),
    timestamp,
    fullPromptText:
      role === 'user' && !excludeFromPromptHistory
        ? extractUserPromptText(stripToolResultBlocks(content))
        : undefined,
    excludeFromPromptHistory
  })
}

export function timestampIso(value: unknown): string | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export function updateLatestLocation(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  const timestamp = extractString(record.timestamp)
  const parsed = timestamp ? Date.parse(timestamp) : accumulator.latestTimestampMs
  if (!Number.isFinite(parsed) || parsed < accumulator.latestTimestampMs) {
    return
  }
  const cwd = extractString(record.cwd)
  const branch = extractString(record.gitBranch)
  if (cwd) {
    accumulator.cwd = cwd
  }
  if (branch) {
    accumulator.branch = branch
  }
}

export function sessionSortTime(session: AiVaultSession): number {
  return Date.parse(session.updatedAt ?? session.modifiedAt)
}

export function sessionIdFromFileName(filePath: string): string {
  const fileName = basename(filePath, extname(filePath))
  const match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return match?.[0] ?? fileName
}
