import {
  completePRCheckOwnerScope,
  acceptPRCheckObservation
} from '../../../src/shared/github/complete-pr-check-owner'
import { useCallback, useRef } from 'react'
import { prSidebarResourceKey, type PrSidebarState } from './mobile-pr-sidebar-state'

/** applied: on screen. stale: superseded or skipped. failed: the read failed and the shown PR stayed. */
export type PrSidebarLoadResult = 'applied' | 'stale' | 'failed'

// A poll's discovery that succeeded with a failed checks read for the same complete PR is not a failed discovery:
// it lands, while the Checks screen keeps the checks it had. Equal numbers in another repository are another PR.
export function pollChecksReadFailed(current: PrSidebarState, next: PrSidebarState): boolean {
  return (
    current.kind === 'ready' &&
    next.kind === 'ready' &&
    next.data.checksError !== null &&
    prSidebarResourceKey(next.data.pr) === prSidebarResourceKey(current.data.pr)
  )
}

export function settleLoadedPr(
  accepted: PrSidebarState,
  next: PrSidebarState,
  background: boolean
): { settled: PrSidebarState; result: 'applied' | 'failed' } {
  if (
    accepted.kind === 'ready' &&
    next.kind === 'ready' &&
    completePRCheckOwnerScope(next.data.pr) !== undefined &&
    completePRCheckOwnerScope(next.data.pr) === completePRCheckOwnerScope(accepted.data.pr) &&
    !next.data.pr.checksSummary
  ) {
    next = {
      ...next,
      data: {
        ...next.data,
        pr: acceptPRCheckObservation(next.data.pr, accepted.data.pr, {
          scope: completePRCheckOwnerScope(next.data.pr)!,
          complete: true,
          current: true
        })!
      }
    }
  }
  if (!background || !pollChecksReadFailed(accepted, next)) {
    return { settled: next, result: 'applied' }
  }
  if (next.kind !== 'ready' || accepted.kind !== 'ready') {
    return { settled: next, result: 'applied' }
  }
  const { checks, checksError } = accepted.data
  return { settled: { ...next, data: { ...next.data, checks, checksError } }, result: 'failed' }
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
