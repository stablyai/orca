// Shared with maintenance so a serving write pauses the next page without a message-loop round trip.

export const JOURNAL_COMPACTION_IDLE_MS = 30_000

export function markJournalWrite(activity: BigInt64Array): void {
  Atomics.store(activity, 0, BigInt(Date.now()))
}

export function journalCompactionIsIdle(activity: BigInt64Array): boolean {
  return BigInt(Date.now() - JOURNAL_COMPACTION_IDLE_MS) >= Atomics.load(activity, 0)
}
