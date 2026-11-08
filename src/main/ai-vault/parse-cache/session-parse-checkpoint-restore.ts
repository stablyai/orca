import type { SessionFileCandidate } from '../session-scanner-types'
import { TranscriptMessageChannel } from '../transcripts/session-transcript-channel'
import type { TranscriptReadStats } from '../transcripts/session-transcript-reader'
import { createClaudeSessionResumeStateFromCheckpoint } from '../scanners/claude/session-scanner-claude-checkpoint'
import type { SessionParseCheckpoint, SessionParseResumePoint } from './session-parse-cache-store'
import { readCheckpointSample } from './session-parse-checkpoint-sample'

export async function checkpointResumeFor(
  candidate: SessionFileCandidate,
  checkpoint: SessionParseCheckpoint,
  stats?: TranscriptReadStats,
  signal?: AbortSignal
): Promise<SessionParseResumePoint | null> {
  if (candidate.agent !== 'claude') {
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
  if (
    (await readCheckpointSample(candidate, checkpoint.byteOffset, stats, signal)) !==
    checkpoint.sampleHash
  ) {
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
export async function sessionParseCheckpointOf(
  candidate: SessionFileCandidate,
  resume: SessionParseResumePoint,
  stats?: TranscriptReadStats,
  signal?: AbortSignal
): Promise<SessionParseCheckpoint | null> {
  const data = resume.state.snapshotResume?.()
  if (!data) {
    return null
  }
  const sampleHash = await readCheckpointSample(candidate, resume.byteOffset, stats, signal)
  if (sampleHash === null) {
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
    sampleHash,
    skippedRecords: resume.skippedRecords,
    snapshot: data.snapshot
  }
}
