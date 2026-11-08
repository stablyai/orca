import { z } from 'zod'
import type { FileWithMtime, ResumableSessionParseState } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import { accumulatorSessionIdentity, createAccumulator } from '../../session-scanner-accumulator'
import {
  cloneClaudeSessionParseState,
  consumeClaudeSessionLine,
  createClaudeSessionParseState,
  finalizeClaudeSessionParseState,
  type ClaudeSessionParseState
} from './session-scanner-primary-parsers'

// Checkpoints survive restarts, so their layout is versioned like any persisted format.
const CLAUDE_CHECKPOINT_PARSER_KIND = 'claude'
const CLAUDE_SESSION_SNAPSHOT_VERSION = 1

const claudeSessionSnapshotSchema = z.object({
  accumulator: z.object({
    sessionId: z.string(),
    title: z.string().nullable(),
    fallbackTitle: z.string().nullable(),
    cwd: z.string().nullable(),
    branch: z.string().nullable(),
    model: z.string().nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    modifiedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    totalTokens: z.number().nonnegative(),
    previewMessages: z.array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
        text: z.string(),
        timestamp: z.string().nullable()
      })
    ),
    previewMessagesTruncated: z.boolean(),
    antigravityOpeningPrompt: z
      .object({ hash: z.string(), timestamp: z.string().nullable() })
      .nullable()
      .optional(),
    firstUserPrompt: z.string().nullable(),
    lastUserPrompt: z.string().nullable(),
    queuedMessageCount: z.number().int().nonnegative(),
    subagentTranscriptCount: z.number().int().nonnegative(),
    earliestTimestampMs: z.number(),
    latestTimestampMs: z.number()
  }),
  metaTitle: z.string().nullable(),
  generatedTitle: z.string().nullable(),
  firstUserTitle: z.string().nullable()
})

type ClaudeSessionParseSnapshot = z.infer<typeof claudeSessionSnapshotSchema>

/**
 * Pure-data snapshot of the parse state at a complete-line boundary. Title sources stay
 * separate (`accumulator.title` vs `metaTitle`/`generatedTitle`/`firstUserTitle`) so a
 * restored fold keeps the existing priority: custom titles hold, generated ones update.
 */
function snapshotClaudeSessionParseState(
  state: ClaudeSessionParseState
): ClaudeSessionParseSnapshot {
  return {
    accumulator: {
      sessionId: state.accumulator.sessionId,
      title: state.accumulator.title,
      fallbackTitle: state.accumulator.fallbackTitle,
      cwd: state.accumulator.cwd,
      branch: state.accumulator.branch,
      model: state.accumulator.model,
      createdAt: state.accumulator.createdAt,
      updatedAt: state.accumulator.updatedAt,
      modifiedAt: state.accumulator.modifiedAt,
      messageCount: state.accumulator.messageCount,
      totalTokens: state.accumulator.totalTokens,
      previewMessages: [...state.accumulator.previewMessages],
      previewMessagesTruncated: state.accumulator.previewMessagesTruncated,
      ...(state.accumulator.antigravityOpeningPrompt === undefined
        ? {}
        : { antigravityOpeningPrompt: state.accumulator.antigravityOpeningPrompt }),
      firstUserPrompt: state.accumulator.firstUserPrompt,
      lastUserPrompt: state.accumulator.lastUserPrompt,
      queuedMessageCount: state.accumulator.queuedMessageCount,
      subagentTranscriptCount: state.accumulator.subagentTranscriptCount,
      earliestTimestampMs: state.accumulator.earliestTimestampMs,
      latestTimestampMs: state.accumulator.latestTimestampMs
    },
    metaTitle: state.metaTitle,
    generatedTitle: state.generatedTitle,
    firstUserTitle: state.firstUserTitle
  }
}

/** Rebuild a resumable Claude state from a persisted checkpoint; null when it cannot be trusted. */
export function createClaudeSessionResumeStateFromCheckpoint(
  file: FileWithMtime,
  messages: TranscriptMessageSink,
  checkpoint: { parserKind: string; snapshotVersion: number; snapshot: unknown }
): ResumableSessionParseState | null {
  if (
    checkpoint.parserKind !== CLAUDE_CHECKPOINT_PARSER_KIND ||
    checkpoint.snapshotVersion !== CLAUDE_SESSION_SNAPSHOT_VERSION
  ) {
    return null
  }
  const parsed = claudeSessionSnapshotSchema.safeParse(checkpoint.snapshot)
  if (!parsed.success) {
    return null
  }
  const snapshot = parsed.data
  const state: ClaudeSessionParseState = {
    // Fresh agent/filePath/messages; the snapshot supplies only the fold data.
    accumulator: {
      ...createAccumulator({
        agent: 'claude',
        file,
        sessionId: snapshot.accumulator.sessionId,
        messages
      }),
      ...snapshot.accumulator
    },
    metaTitle: snapshot.metaTitle,
    generatedTitle: snapshot.generatedTitle,
    firstUserTitle: snapshot.firstUserTitle
  }
  return claudeResumeStateFromParseState(state)
}

export function createClaudeSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return claudeResumeStateFromParseState(createClaudeSessionParseState(file, messages))
}

function claudeResumeStateFromParseState(
  state: ClaudeSessionParseState
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeClaudeSessionLine(state, line),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () => claudeResumeStateFromParseState(cloneClaudeSessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeClaudeSessionParseState(state, platform, options),
    snapshotResume: () => ({
      parserKind: CLAUDE_CHECKPOINT_PARSER_KIND,
      snapshotVersion: CLAUDE_SESSION_SNAPSHOT_VERSION,
      snapshot: snapshotClaudeSessionParseState(state)
    })
  }
}
