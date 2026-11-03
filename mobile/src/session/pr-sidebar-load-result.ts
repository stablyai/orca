import { useCallback, useRef } from 'react'
import { prSidebarReviewKey, type PrSidebarState } from './mobile-pr-sidebar-state'

/** applied: on screen. stale: superseded or skipped. failed: a read failed and what it would have replaced stayed. */
export type PrSidebarLoadResult = 'applied' | 'stale' | 'failed'

// A background read keeps what is on screen when its read fails; the poller backs off instead.
export function backgroundReadFailed(current: PrSidebarState, next: PrSidebarState): boolean {
  return current.kind === 'ready' && (next.kind === 'error' || next.kind === 'blocked')
}

// A failed checks read on the same review keeps the checks it had rather than emptying the Checks screen,
// while the PR it read (state, title, merge status) still lands: a write's reread must show a merge or close.
export function keepShownChecks(current: PrSidebarState, next: PrSidebarState): PrSidebarState {
  if (
    current.kind !== 'ready' ||
    next.kind !== 'ready' ||
    next.data.checksError === null ||
    prSidebarReviewKey(current.data.pr) !== prSidebarReviewKey(next.data.pr)
  ) {
    return next
  }
  const { checks, checksError } = current.data
  return { kind: 'ready', data: { ...next.data, checks, checksError } }
}

// A poll never supersedes a read the user started or a write's reread; it skips and tries again later.
// A write's reread is never skipped, and like a poll it keeps the shown PR when its read fails.
export function useForegroundFirstLoad<Options extends { background?: boolean }>(
  loadOnce: (options?: Options, afterWrite?: boolean) => Promise<PrSidebarLoadResult>
) {
  const foregroundLoadsRef = useRef(0)
  const run = useCallback(
    async (options: Options | undefined, afterWrite: boolean): Promise<PrSidebarLoadResult> => {
      if (options?.background) {
        return foregroundLoadsRef.current > 0 ? 'stale' : loadOnce(options)
      }
      foregroundLoadsRef.current += 1
      try {
        return await loadOnce(options, afterWrite)
      } finally {
        foregroundLoadsRef.current -= 1
      }
    },
    [loadOnce]
  )
  return {
    load: useCallback((options?: Options) => run(options, false), [run]),
    rereadAfterWrite: useCallback(async (): Promise<void> => {
      await run(undefined, true)
    }, [run])
  }
}
