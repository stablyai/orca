/**
 * A reader's frozen records: their charges as prefix sums, where the queue stood, and whether a
 * later write actually replaced the captured tail while it was still queued.
 */
export type FrozenReadSource = {
  base: number
  cumulative: number[]
  tailReplaced: boolean
  sever: () => void
}

/** Captured records the writer has committed out of its queue: `k` of `n`. */
export function frozenReadSplit(
  frozen: FrozenReadSource,
  committed: number,
  gapped: boolean
): { count: number; left: number } {
  const count = frozen.cumulative.length - 1
  // A gap drops the queue: every frozen record is then the reader's alone.
  const left = gapped ? count : Math.min(count, Math.max(0, committed - frozen.base))
  return { count, left }
}

/** frozen-only = P[k] + (replaced tail still queued ? its charge : 0), records likewise. */
export function frozenReadCharge(
  frozen: FrozenReadSource | null,
  committed: number,
  gapped: boolean,
  tailReplaced: boolean
): { bytes: number; records: number } {
  if (!frozen) {
    return { bytes: 0, records: 0 }
  }
  const { count, left } = frozenReadSplit(frozen, committed, gapped)
  const tail = tailReplaced && left < count
  const cumulative = frozen.cumulative
  return {
    bytes: cumulative[left] + (tail ? cumulative[count] - cumulative[count - 1] : 0),
    records: left + (tail ? 1 : 0)
  }
}
