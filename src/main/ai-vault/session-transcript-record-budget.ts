export const MAX_SESSION_TRANSCRIPT_RECORD_BYTES = 10 * 1024 * 1024

// Skip and report oversized records without dropping the rest of the session.
export type SkippedTranscriptRecord = {
  /** File offset the record starts at — its identity across incremental reads. */
  byteOffset: number
  /** Bytes discarded, excluding the newline; a lower bound while unterminated. */
  approximateBytes: number
}

// Bound diagnostics retained in each in-memory resume point.
const MAX_TRACKED_SKIPPED_RECORDS = 32
const DESCRIBED_SKIPPED_RECORDS = 3

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

export function describeSkippedTranscriptRecords(
  records: readonly SkippedTranscriptRecord[]
): string | null {
  if (records.length === 0) {
    return null
  }
  const sizes = records
    .slice(0, DESCRIBED_SKIPPED_RECORDS)
    .map((record) => `${formatMebibytes(record.approximateBytes)} at byte ${record.byteOffset}`)
  if (records.length > DESCRIBED_SKIPPED_RECORDS) {
    sizes.push(`${records.length - DESCRIBED_SKIPPED_RECORDS} more`)
  }
  const plural = records.length === 1 ? 'record' : 'records'
  return `Skipped ${records.length} oversized transcript ${plural} over the ${formatMebibytes(
    MAX_SESSION_TRANSCRIPT_RECORD_BYTES
  )} limit (${sizes.join(', ')}). The rest of the session was read.`
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
