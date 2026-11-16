import type {
  JournalReaderAdmission,
  JournalReaderAdmissionStats
} from './journal-sql-reader-admission'

const admissions = new Set<WeakRef<JournalReaderAdmission>>()

export function trackJournalReaderAdmission(admission: JournalReaderAdmission): void {
  admissions.add(new WeakRef(admission))
}

/** Every open reader pool, summed; read on the diagnostics sampler's cadence. */
export function readJournalReaderRetention(): JournalReaderAdmissionStats {
  const total: JournalReaderAdmissionStats = {
    inFlight: 0,
    unconsumed: 0,
    waiting: 0,
    oldestWaitMs: 0,
    reservedBytes: 0,
    receivedBytes: 0,
    consumedBytes: 0
  }
  for (const ref of admissions) {
    const admission = ref.deref()
    if (!admission) {
      admissions.delete(ref)
      continue
    }
    const stats = admission.stats()
    total.inFlight += stats.inFlight
    total.unconsumed += stats.unconsumed
    total.waiting += stats.waiting
    total.oldestWaitMs = Math.max(total.oldestWaitMs, stats.oldestWaitMs)
    total.reservedBytes += stats.reservedBytes
    total.receivedBytes += stats.receivedBytes
    total.consumedBytes += stats.consumedBytes
  }
  return total
}
