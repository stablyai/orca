import type { ReaderSlot } from './journal-sql-reader-slot'

/** Keep one reader warm for zero-latency single reads; retire idle burst readers after quiet periods. */
export const MIN_WARM_JOURNAL_SQL_READERS = 1
export const IDLE_BURST_READER_TTL_MS = 30_000

/** Schedules one-shot retirement of excess idle burst reader slots while preserving one warm reader. */
export class JournalSqlReaderBurstShrink {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly onShrink: () => boolean,
    private readonly ttlMs = IDLE_BURST_READER_TTL_MS
  ) {}

  schedule(): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.onShrink()) {
        this.schedule()
      }
    }, this.ttlMs)
    this.timer.unref?.()
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

export type ReplacedReaderTotals = {
  receivedBytes: number
  consumedBytes: number
  creditWaitsExpired: number
}

export function retireJournalReaderSlot(
  slots: ReaderSlot[],
  index: number,
  replaced: ReplacedReaderTotals,
  retiring: Set<Promise<void>>
): void {
  const [retired] = slots.splice(index, 1)
  const stats = retired!.admissionStats()
  replaced.receivedBytes += stats.receivedBytes
  replaced.consumedBytes += stats.consumedBytes
  replaced.creditWaitsExpired += stats.creditWaitsExpired
  const closed = retired!.close().finally(() => retiring.delete(closed))
  retiring.add(closed)
}

export function shrinkIdleBurstReaders(
  slots: ReaderSlot[],
  reserved: readonly (ReaderSlot | undefined)[],
  replaced: ReplacedReaderTotals,
  retiring: Set<Promise<void>>,
  minWarm = MIN_WARM_JOURNAL_SQL_READERS
): boolean {
  for (let index = slots.length - 1; index >= 0 && slots.length > minWarm; index--) {
    const candidate = slots[index]!
    if (reserved.includes(candidate) || candidate.pendingCount > 0) {
      continue
    }
    retireJournalReaderSlot(slots, index, replaced, retiring)
  }
  return slots.length > minWarm
}
