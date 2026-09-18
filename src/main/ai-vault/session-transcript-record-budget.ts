export const MAX_SESSION_TRANSCRIPT_RECORD_BYTES = 10 * 1024 * 1024

export function assertSessionTranscriptRecordBytes(bytes: number): void {
  if (bytes > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
    throw new Error(
      `Session transcript record exceeds ${MAX_SESSION_TRANSCRIPT_RECORD_BYTES} byte limit`
    )
  }
}
