import type { JournalReaderAdmissionStats } from './journal-sql-reader-admission'

export type JournalReaderRetention = JournalReaderAdmissionStats & {
  /** Charged reply bytes readers posted that main has not consumed. */
  outstandingBytes: number
}

type RetentionSource = { retention(): JournalReaderRetention }

const pools = new Set<WeakRef<RetentionSource>>()

export function trackJournalReaderRetention(pool: RetentionSource): void {
  pools.add(new WeakRef(pool))
}

/** Every open reader pool, summed; read on the diagnostics sampler's cadence. */
export function readJournalReaderRetention(): JournalReaderRetention {
  const total: JournalReaderRetention = {
    inFlight: 0,
    unconsumed: 0,
    waiting: 0,
    oldestWaitMs: 0,
    receivedBytes: 0,
    consumedBytes: 0,
    creditWaitsExpired: 0,
    outstandingBytes: 0
  }
  for (const ref of pools) {
    const pool = ref.deref()
    if (!pool) {
      pools.delete(ref)
      continue
    }
    const stats = pool.retention()
    total.inFlight += stats.inFlight
    total.unconsumed += stats.unconsumed
    total.waiting += stats.waiting
    total.oldestWaitMs = Math.max(total.oldestWaitMs, stats.oldestWaitMs)
    total.receivedBytes += stats.receivedBytes
    total.consumedBytes += stats.consumedBytes
    total.creditWaitsExpired += stats.creditWaitsExpired
    total.outstandingBytes += stats.outstandingBytes
  }
  return total
}
