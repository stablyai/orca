export const MAX_SESSION_TRANSCRIPT_RECORD_BYTES = 10 * 1024 * 1024

// Why: one absurd record (a base64 image, a runaway tool result) used to abort
// the whole fold, which dropped the entire session from the vault. The reader
// discards the offending record instead and reports it here, so the loss is one
// record wide and still visible.
export type SkippedTranscriptRecord = {
  /** File offset the record starts at — its identity across incremental reads. */
  byteOffset: number
  /** Bytes discarded, excluding the newline; a lower bound while unterminated. */
  approximateBytes: number
}

// Bounded because a multi-GB transcript could hold hundreds of oversized
// records, and this list rides along with the in-memory resume point.
const MAX_TRACKED_SKIPPED_RECORDS = 32
const DESCRIBED_SKIPPED_RECORDS = 3

/**
 * Fold a read's skips into the ones the resume point already carries. Keyed by
 * start offset: an unterminated tail is re-skipped at the same offset on the
 * next read, and grows rather than duplicating once its newline arrives.
 */
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

/** Human-readable scan-issue text, or null when the fold dropped nothing. */
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
