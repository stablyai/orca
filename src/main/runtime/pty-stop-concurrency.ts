export const WORKTREE_PTY_STOP_CONCURRENCY = 8

export async function mapPtyStopsWithConcurrency<T>(
  ptyIds: readonly string[],
  stopPty: (ptyId: string) => Promise<T>
): Promise<T[]> {
  const results = Array<T>(ptyIds.length)
  let nextIndex = 0
  let didFail = false
  let firstError: unknown
  const stopNext = async (): Promise<void> => {
    while (nextIndex < ptyIds.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await stopPty(ptyIds[index])
      } catch (error) {
        // Why: deletion must attempt and await every snapshotted PTY even when
        // one provider rejects, otherwise active workers can outlive Git removal.
        if (!didFail) {
          firstError = error
        }
        didFail = true
      }
    }
  }
  // Why: remote tools may each consume the full timeout. A small worker pool
  // bounds resource use without making teardown latency linear in PTY count.
  const workers = Array.from(
    { length: Math.min(WORKTREE_PTY_STOP_CONCURRENCY, ptyIds.length) },
    () => stopNext()
  )
  await Promise.all(workers)
  if (didFail) {
    throw firstError
  }
  return results
}
