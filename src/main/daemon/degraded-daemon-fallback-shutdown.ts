import type { IPtyProvider } from '../providers/pty-provider-contract'

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
  // Failed local cleanup must not abort daemon-restart recovery.
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length > 0) {
    console.warn(
      `[daemon] ${failed.length} local fallback PTY session(s) failed to shut down during daemon restart; continuing restart`,
      ...failed.map((result) => (result as PromiseRejectedResult).reason)
    )
  }
  return results.length - failed.length
}
