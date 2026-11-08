import type { SessionFileCandidate } from '../session-scanner-types'
import { TranscriptMessageChannel } from '../transcripts/session-transcript-channel'
import { hasTranscriptConsumers } from '../transcripts/session-transcript-consumers'
import { createClaudeSessionResumeStateFromCheckpoint } from '../scanners/claude/session-scanner-claude-checkpoint'
import type { SessionParseCheckpoint, SessionParseResumePoint } from './session-parse-cache-store'

export function checkpointResumeFor(
  candidate: SessionFileCandidate,
  checkpoint: SessionParseCheckpoint
): SessionParseResumePoint | null {
  // Consumers prove their persisted prefix against a replacement stream after restart.
  if (candidate.agent !== 'claude' || hasTranscriptConsumers()) {
    return null
  }
  if (
    (checkpoint.fileIdentity?.dev ?? null) !== (candidate.file.dev ?? null) ||
    (checkpoint.fileIdentity?.ino ?? null) !== (candidate.file.ino ?? null)
  ) {
    return null
  }
  const channel = new TranscriptMessageChannel()
  const state = createClaudeSessionResumeStateFromCheckpoint(candidate.file, channel, checkpoint)
  if (!state) {
    return null
  }
  return {
    state,
    mtimeMs: checkpoint.mtimeMs,
    sizeBytes: checkpoint.sizeBytes === null ? undefined : checkpoint.sizeBytes,
    byteOffset: checkpoint.byteOffset,
    channel,
    skippedRecords: checkpoint.skippedRecords,
    // A restart cannot continue the previous hash chain; consumers see a missing prefix hash.
    prefixHash: null
  }
}

/** Compose the persisted checkpoint from a finished read; null when the parser cannot snapshot. */
export function sessionParseCheckpointOf(
  candidate: SessionFileCandidate,
  resume: SessionParseResumePoint
): SessionParseCheckpoint | null {
  const data = resume.state.snapshotResume?.()
  if (!data) {
    return null
  }
  return {
    parserKind: data.parserKind,
    snapshotVersion: data.snapshotVersion,
    // The reader's consumedThrough is always a complete-line boundary.
    byteOffset: resume.byteOffset,
    mtimeMs: candidate.file.mtimeMs,
    sizeBytes: candidate.file.sizeBytes ?? null,
    fileIdentity:
      typeof candidate.file.dev === 'number' && typeof candidate.file.ino === 'number'
        ? { dev: candidate.file.dev, ino: candidate.file.ino }
        : null,
    skippedRecords: resume.skippedRecords,
    snapshot: data.snapshot
  }
}
