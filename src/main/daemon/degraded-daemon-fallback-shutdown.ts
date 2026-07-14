import type { IPtyProvider } from '../providers/types'

export async function shutdownDegradedFallbackSessions<T extends IPtyProvider>(
  sessionProviders: Map<string, T>,
  fallback: T
): Promise<number> {
  const ids = [...sessionProviders]
    .filter(([, provider]) => provider === fallback)
    .map(([id]) => id)
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      await fallback.shutdown(id, { immediate: true })
      sessionProviders.delete(id)
    })
  )
  // Why: fallback cleanup must not abort the user's daemon-restart recovery path.
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length > 0) {
    console.warn(
      `[daemon] ${failed.length} local fallback PTY session(s) failed to shut down during daemon restart; continuing restart`,
      ...failed.map((result) => (result as PromiseRejectedResult).reason)
    )
  }
  return results.length - failed.length
}
