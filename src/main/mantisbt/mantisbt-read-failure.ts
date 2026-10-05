import type { MantisBTSiteSelection } from '../../shared/mantisbt-types'

export type MantisBTReadFailure = {
  error: unknown
  auth: boolean
}

/** Run against one signal that trips on the caller's abort or the request deadline. */
export async function withMantisBTDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (deadlineSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  const timer = setTimeout(abort, timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

// Why: a specific single-site read should fail loudly (the caller asked for
// that one site); an 'all' fan-out tolerates a partial failure so one bad
// connected site does not hide the others' results.
export function shouldSurfaceSiteFailure(
  selection: MantisBTSiteSelection | null | undefined,
  entryCount: number
): boolean {
  return selection !== 'all' && entryCount <= 1
}

/** Evict a site's token without letting a deletion I/O failure mask the read failure that triggered it. */
export function evictSiteTokenSafely(clearToken: (siteId: string) => void, siteId: string): void {
  try {
    clearToken(siteId)
  } catch (error) {
    console.warn('[mantisBT] failed to evict invalid token:', error)
  }
}
