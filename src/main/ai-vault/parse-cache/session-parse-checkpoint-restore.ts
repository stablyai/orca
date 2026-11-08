import type { SessionFileCandidate } from '../session-scanner-types'
import { TranscriptMessageChannel } from '../transcripts/session-transcript-channel'
import type { TranscriptReadStats } from '../transcripts/session-transcript-reader'
import { createClaudeSessionResumeStateFromCheckpoint } from '../scanners/claude/session-scanner-claude-checkpoint'
import type { SessionParseCheckpoint, SessionParseResumePoint } from './session-parse-cache-store'
import { readCheckpointSample } from './session-parse-checkpoint-sample'
import { hashTranscriptSample } from '../transcripts/session-transcript-sample'

/** Restore a Claude fold only after its identity, version and committed byte windows validate. */
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
  const sample = await readCheckpointSample(candidate, checkpoint.byteOffset, stats, signal)
  if (!sample || hashTranscriptSample(sample, checkpoint.byteOffset) !== checkpoint.sampleHash) {
    return null
  }
  return {
    state,
    mtimeMs: checkpoint.mtimeMs,
    sizeBytes: checkpoint.sizeBytes === null ? undefined : checkpoint.sizeBytes,
    byteOffset: checkpoint.byteOffset,
    channel,
    sample,
    skippedRecords: checkpoint.skippedRecords,
    // A restart cannot continue the previous hash chain; consumers see a missing prefix hash.
    prefixHash: null
  }
}

/** Snapshot a completed fold and its stream-derived sample without accessing the filesystem. */
export function sessionParseCheckpointOf(
  candidate: SessionFileCandidate,
  resume: SessionParseResumePoint
): SessionParseCheckpoint | null {
  const data = resume.state.snapshotResume?.()
  if (!data || !resume.sample) {
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
    sampleHash: hashTranscriptSample(resume.sample, resume.byteOffset),
    skippedRecords: resume.skippedRecords,
    snapshot: data.snapshot
  }
}
