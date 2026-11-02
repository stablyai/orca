import { useCallback, useRef } from 'react'
import type { PrSidebarState } from './mobile-pr-sidebar-state'

/** applied: on screen. stale: superseded or skipped. failed: the read failed and the shown PR stayed. */
export type PrSidebarLoadResult = 'applied' | 'stale' | 'failed'

// A background poll keeps what is on screen when its read fails; the poller backs off instead.
// A failed checks read on the same PR keeps the checks it had rather than emptying the Checks screen.
export function backgroundReadFailed(current: PrSidebarState, next: PrSidebarState): boolean {
  return (
    current.kind === 'ready' &&
    (next.kind === 'error' ||
      next.kind === 'blocked' ||
      (next.kind === 'ready' &&
        next.data.checksError !== null &&
        next.data.pr.number === current.data.pr.number))
  )
}

// A poll never supersedes a read the user started; it skips and tries again later.
export function useForegroundFirstLoad<Options extends { background?: boolean }>(
  loadOnce: (options?: Options) => Promise<PrSidebarLoadResult>
): (options?: Options) => Promise<PrSidebarLoadResult> {
  const foregroundLoadsRef = useRef(0)
  return useCallback(
    async (options?: Options) => {
      if (options?.background) {
        return foregroundLoadsRef.current > 0 ? 'stale' : loadOnce(options)
      }
      foregroundLoadsRef.current += 1
      try {
        return await loadOnce(options)
      } finally {
        foregroundLoadsRef.current -= 1
      }
    },
    [loadOnce]
  )
}
