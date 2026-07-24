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
  normalizePreviewText,
  timestampMs
} from './session-scanner-values'

const SESSION_PREVIEW_MESSAGE_LIMIT = 5

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
    lastUserPrompt: null,
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    latestTimestampMs: 0
  }
}

export function cloneSessionAccumulator(accumulator: SessionAccumulator): SessionAccumulator {
  return { ...accumulator, previewMessages: [...accumulator.previewMessages] }
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
    ...(accumulator.lastUserPrompt ? { lastUserPrompt: accumulator.lastUserPrompt } : {}),
    queuedMessageCount: accumulator.queuedMessageCount,
    subagentTranscriptCount: accumulator.subagentTranscriptCount,
    resumeCommand: buildAiVaultResumeCommand({
      agent: accumulator.agent,
      sessionId,
      resumeFilePath: accumulator.filePath,
      cwd: accumulator.cwd,
      platform,
      codexHome: options.codexHome
    }),
    subagent: null
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
  }
): void {
  const text = normalizePreviewText(args.text ?? '')
  if (!text) {
    return
  }
  accumulator.previewMessages.push({
    role: args.role,
    text,
    timestamp: timestampIso(args.timestamp)
  })
  if (accumulator.previewMessages.length > SESSION_PREVIEW_MESSAGE_LIMIT) {
    accumulator.previewMessages.shift()
  }
}

export function addPreviewContent(
  accumulator: SessionAccumulator,
  role: AiVaultSessionPreviewMessage['role'],
  content: unknown,
  timestamp?: unknown
): void {
  addPreviewMessage(accumulator, {
    role,
    text: extractPreviewContentText(content),
    timestamp
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
