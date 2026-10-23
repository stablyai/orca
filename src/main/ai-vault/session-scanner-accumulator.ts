import { basename, extname } from 'node:path'
import {
  aiVaultAgentLabel,
  type AiVaultAgent,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import { extractString, timestampMs } from './session-scanner-values'
import {
  NO_TRANSCRIPT_MESSAGES,
  type TranscriptMessageSink,
  type TranscriptSessionIdentity
} from './session-transcript-consumers'

export function createAccumulator(args: {
  agent: AiVaultAgent
  file: FileWithMtime
  sessionId: string
  // Where every decoded message goes; absent for one-shot parses with no reader.
  messages?: TranscriptMessageSink
}): SessionAccumulator {
  return {
    agent: args.agent,
    messages: args.messages ?? NO_TRANSCRIPT_MESSAGES,
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
    previewMessagesTruncated: false,
    firstUserPrompt: null,
    lastUserPrompt: null,
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    earliestTimestampMs: 0,
    latestTimestampMs: 0
  }
}

/**
 * The session identity a fold holds right now. Null until it has an id, which
 * every supported format writes in the opening lines of the transcript.
 */
export function accumulatorSessionIdentity(
  accumulator: SessionAccumulator
): TranscriptSessionIdentity | null {
  const sessionId = accumulator.sessionId.trim()
  if (!sessionId) {
    return null
  }
  return {
    sessionId,
    cwd: accumulator.cwd,
    // The generated fallback is `finalizeSession`'s, not this one's: a title
    // that is still absent mid-read is better said to be absent.
    title: accumulator.title ?? accumulator.fallbackTitle,
    createdAt: accumulator.createdAt,
    updatedAt: accumulator.updatedAt
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
    identity: () => accumulatorSessionIdentity(accumulator),
    clone: () =>
      accumulatorFoldResumeState(cloneSessionAccumulator(accumulator), consumeRecordLine),
    touchFile: (file) => {
      accumulator.modifiedAt = file.modifiedAt
    },
    // Finalize a snapshot: the live accumulator (and its preview array) keeps
    // accumulating appended lines after this session object is handed out.
    // A sibling file's metadata is merged onto this result by the parse cache,
    // never into the fold, so re-merging it later starts from what the
    // transcript alone said (see session-scanner-sidecar-enrichment.ts).
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
    generatedSessionTitle(accumulator.agent, sessionId)

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
    ...(accumulator.previewMessagesTruncated ? { previewMessagesTruncated: true } : {}),
    ...(accumulator.antigravityOpeningPrompt
      ? { antigravityOpeningPrompt: accumulator.antigravityOpeningPrompt }
      : {}),
    ...(accumulator.firstUserPrompt ? { firstUserPrompt: accumulator.firstUserPrompt } : {}),
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

/**
 * The title a session gets when neither the transcript nor the agent named it.
 * Exported so a later merge can tell "the fold found no title" from a real one
 * without re-deriving the string (session-scanner-sidecar-enrichment.ts).
 */
export function generatedSessionTitle(agent: AiVaultAgent, sessionId: string): string {
  return `${aiVaultAgentLabel(agent)} ${sessionId.slice(0, 8)}`
}

export function updateTimeline(accumulator: SessionAccumulator, timestamp: unknown): void {
  const parsed = timestampMs(timestamp)
  if (!Number.isFinite(parsed)) {
    return
  }
  const iso = new Date(parsed).toISOString()
  if (!accumulator.createdAt || parsed < accumulator.earliestTimestampMs) {
    accumulator.createdAt = iso
    accumulator.earliestTimestampMs = Math.trunc(parsed)
  }
  // ISO serialization truncates fractional milliseconds; latestTimestampMs retains them.
  if (!accumulator.updatedAt || parsed >= Math.trunc(accumulator.latestTimestampMs)) {
    accumulator.updatedAt = iso
    accumulator.latestTimestampMs = parsed
  }
}

export function timestampIso(value: unknown): string | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export function updateLatestLocation(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  // Why: a session's representative cwd is its START directory, not its latest.
  // `claude --resume <id>` only finds the transcript under the project dir keyed
  // by the start cwd, and history grouping/filtering key off the session origin;
  // a later drifted cwd broke resume for sessions that changed directory (#9361).
  // Transcripts are append-only, so the first record carrying a cwd is the start.
  if (accumulator.cwd === null) {
    const startCwd = extractString(record.cwd)
    if (startCwd) {
      accumulator.cwd = startCwd
    }
  }
  const timestamp = extractString(record.timestamp)
  const parsed = timestamp ? Date.parse(timestamp) : accumulator.latestTimestampMs
  if (!Number.isFinite(parsed) || parsed < accumulator.latestTimestampMs) {
    return
  }
  const branch = extractString(record.gitBranch)
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
