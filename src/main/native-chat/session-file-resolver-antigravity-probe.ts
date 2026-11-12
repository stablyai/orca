import { join } from 'node:path'
import { toHostReadableTranscriptPath } from './host-readable-transcript-path'
import { isSafeSessionIdPathSegment } from './session-id-path-segment'

// The full transcript keeps tool args that the compact one truncates.
const ANTIGRAVITY_TRANSCRIPT_FILES = ['transcript_full.jsonl', 'transcript.jsonl']

export async function findAntigravityBrainTranscript(
  brainDir: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!isSafeSessionIdPathSegment(sessionId)) {
    return null
  }
  const logsDir = join(brainDir, sessionId, '.system_generated', 'logs')
  for (const filename of ANTIGRAVITY_TRANSCRIPT_FILES) {
    const candidate = await toHostReadableTranscriptPath(join(logsDir, filename), { signal })
    if (candidate) {
      return candidate
    }
  }
  return null
}
