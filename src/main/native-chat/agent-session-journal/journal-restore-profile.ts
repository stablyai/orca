/** Optional scoped measurement; ordinary opens install no observer. */
export type JournalRestoreProfile = {
  measure: <T>(
    phase: 'outcome-read' | 'outcome-admission' | 'raw-read' | 'raw-admission',
    work: () => T
  ) => T
}

export function* profileJournalRestoreRows<T>(
  rows: Iterable<T>,
  profile: JournalRestoreProfile
): Generator<T> {
  const iterator = rows[Symbol.iterator]()
  try {
    for (;;) {
      const next = profile.measure('raw-read', () => iterator.next())
      if (next.done) {
        return
      }
      yield next.value
    }
  } finally {
    iterator.return?.()
  }
}
