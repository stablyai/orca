export const MAX_SESSION_TRANSCRIPT_RECORD_BYTES = 10 * 1024 * 1024

// Retain oversized-record diagnostics without dropping the rest of the session.
export type SkippedTranscriptRecord = {
  /** File offset the record starts at — its identity across incremental reads. */
  byteOffset: number
  /** Bytes discarded, excluding the newline; a lower bound while unterminated. */
  approximateBytes: number
}

// Bound diagnostics retained in each in-memory resume point.
const MAX_TRACKED_SKIPPED_RECORDS = 32

/** Merge by offset so an incomplete tail grows into one diagnostic when its newline arrives. */
export function mergeSkippedTranscriptRecords(
  previous: readonly SkippedTranscriptRecord[],
  next: readonly SkippedTranscriptRecord[]
): SkippedTranscriptRecord[] {
  if (next.length === 0) {
    return [...previous]
  }
  const byOffset = new Map<number, SkippedTranscriptRecord>()
  for (const record of [...previous, ...next]) {
    const existing = byOffset.get(record.byteOffset)
    if (!existing || record.approximateBytes > existing.approximateBytes) {
      byOffset.set(record.byteOffset, record)
    }
  }
  return [...byOffset.values()]
    .sort((a, b) => a.byteOffset - b.byteOffset)
    .slice(0, MAX_TRACKED_SKIPPED_RECORDS)
}
