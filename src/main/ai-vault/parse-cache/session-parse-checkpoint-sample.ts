import { readTranscriptSlice, transcriptFileStat } from '../../native-chat/wsl-transcript-fs-access'
import type { SessionFileCandidate } from '../session-scanner-types'
import type { TranscriptReadStats } from '../transcripts/session-transcript-reader'
import {
  appendTranscriptSample,
  type TranscriptSample
} from '../transcripts/session-transcript-sample'

const SAMPLE_BYTES = 4096

/** Read bounded restore windows; invalid observations return null and I/O errors propagate. */
export async function readCheckpointSample(
  candidate: SessionFileCandidate,
  byteOffset: number,
  stats?: TranscriptReadStats,
  signal?: AbortSignal
): Promise<TranscriptSample | null> {
  let sample: TranscriptSample = { head: Buffer.alloc(0), tail: Buffer.alloc(0) }
  const headLength = Math.min(byteOffset, SAMPLE_BYTES)
  const tailStart = Math.max(headLength, byteOffset - SAMPLE_BYTES)
  for (const [start, length] of [
    [0, headLength],
    [tailStart, byteOffset - tailStart]
  ] as const) {
    if (length === 0) {
      continue
    }
    const bytes = await readTranscriptSlice(candidate.file.path, start, length, 'scan', signal)
    if (stats) {
      stats.bytesRead += bytes.length
    }
    if (bytes.length !== length) {
      return null
    }
    sample = appendTranscriptSample(sample, bytes)
  }
  if (byteOffset > 0) {
    const observed = await transcriptFileStat(candidate.file.path, 'scan', signal)
    const file = candidate.file
    if (
      observed.size !== file.sizeBytes ||
      observed.mtimeMs !== file.mtimeMs ||
      (file.dev !== undefined && file.dev !== observed.dev) ||
      (file.ino !== undefined && file.ino !== observed.ino)
    ) {
      return null
    }
  }
  return sample
}
