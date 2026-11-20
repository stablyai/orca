/**
 * Waits for startup phases: 'ready' once every one settles, 'timeout' after `timeoutMs`, and
 * 'aborted' as soon as any signal aborts (the caller went away).
 */
export async function waitForStartupPhases(
  phases: readonly Promise<unknown>[],
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[] = []
): Promise<'ready' | 'timeout' | 'aborted'> {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (live.some((signal) => signal.aborted)) {
    return 'aborted'
  }
  if (phases.length === 0) {
    return 'ready'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []
  const settled = new Promise<'timeout' | 'aborted'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    for (const signal of live) {
      const onAbort = (): void => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    }
  })
  try {
    return await Promise.race([Promise.all(phases).then(() => 'ready' as const), settled])
  } finally {
    clearTimeout(timer)
    for (const cleanup of cleanups) {
      cleanup()
    }
  }
}
