const READ_CONCURRENCY = 16

/** Runs at most `READ_CONCURRENCY` at once; starts nothing after a failure or once `done()` holds, and rejects only once every started run has settled. */
export async function forEachBounded<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  done: () => boolean = () => false
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | undefined
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
      while (next < items.length && !failure && !done()) {
        const item = items[next++]
        try {
          await run(item)
        } catch (error) {
          failure ??= { error }
        }
      }
    })
  )
  if (failure) {
    throw failure.error
  }
}
