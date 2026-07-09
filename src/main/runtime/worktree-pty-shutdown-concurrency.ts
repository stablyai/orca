export const WORKTREE_PTY_SHUTDOWN_CONCURRENCY = 6

export async function runWorktreePtyShutdownsWithBoundedConcurrency<T>(
  ids: string[],
  stopPty: (id: string) => Promise<T>
): Promise<T[]> {
  const results: T[] = Array.from({ length: ids.length })
  let nextIndex = 0

  const runNext = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= ids.length) {
        return
      }
      results[index] = await stopPty(ids[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(WORKTREE_PTY_SHUTDOWN_CONCURRENCY, ids.length) }, () => runNext())
  )
  return results
}
