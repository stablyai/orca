import type { ReaderSlot } from './journal-sql-reader-slot'

/** Keep one reader warm during active chat reads; retire burst readers after 30s and the last idle warm reader after 2m so the hosted UtilityProcess can exit. */
export const MIN_WARM_JOURNAL_SQL_READERS = 1
export const IDLE_BURST_READER_TTL_MS = 30_000
export const IDLE_WARM_READER_TTL_MS = 2 * 60_000

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

  /** Arm the shrink timer if not already running, without resetting an in-progress countdown. */
  ensureScheduled(): void {
    if (this.timer === undefined) {
      this.schedule()
    }
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/** Coordinates 30s burst-reader shrinking and 2m full idle retirement so the hosted UtilityProcess can exit. */
export class JournalSqlReaderIdleShrink {
  private readonly burst: JournalSqlReaderBurstShrink
  private readonly warm: JournalSqlReaderBurstShrink

  constructor(
    callbacks: { onBurstShrink: () => boolean; onWarmShrink: () => boolean },
    burstTtlMs = IDLE_BURST_READER_TTL_MS,
    warmTtlMs = IDLE_WARM_READER_TTL_MS
  ) {
    this.burst = new JournalSqlReaderBurstShrink(callbacks.onBurstShrink, burstTtlMs)
    this.warm = new JournalSqlReaderBurstShrink(callbacks.onWarmShrink, warmTtlMs)
  }

  onSlotUsed(slotCount: number, slotIndex: number, minWarm = MIN_WARM_JOURNAL_SQL_READERS): void {
    if (slotCount > minWarm) {
      // Only burst-slot usage extends the burst TTL; steady warm-slot reads must not starve excess reader retirement.
      if (slotIndex >= minWarm) {
        this.burst.schedule()
      } else {
        this.burst.ensureScheduled()
      }
    }
    this.warm.schedule()
  }

  clear(): void {
    this.burst.clear()
    this.warm.clear()
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
  minWarm = MIN_WARM_JOURNAL_SQL_READERS,
  onRetire?: (slot: ReaderSlot) => void
): boolean {
  for (let index = slots.length - 1; index >= 0 && slots.length > minWarm; index--) {
    const candidate = slots[index]!
    if (reserved.includes(candidate) || candidate.pendingCount > 0) {
      continue
    }
    retireJournalReaderSlot(slots, index, replaced, retiring)
    onRetire?.(candidate)
  }
  return slots.length > minWarm
}
