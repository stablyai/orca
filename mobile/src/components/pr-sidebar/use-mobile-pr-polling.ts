import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  ChecksDetailPollingPolicy,
  nextChecksPollBackoffMs
} from '../../../../src/shared/github/checks-detail-polling-policy'
import { REVIEW_REFRESH_COOLDOWN_MS } from '../../../../src/shared/review-refresh-policy'
import { useAppActive } from '../../hooks/use-now'
import type { PrSidebarState } from '../../session/mobile-pr-sidebar-state'
import type { PrSidebarLoadOptions } from '../../session/use-mobile-pr-sidebar-controller'
import type { PrSidebarLoadResult } from '../../session/pr-sidebar-load-result'

/** What is on screen: nothing to keep fresh, the PR and its checks, or its comments too. */
export type PrTabLive = false | 'checks' | 'details'

type Input = {
  state: PrSidebarState
  refetch: (options?: PrSidebarLoadOptions) => Promise<PrSidebarLoadResult> | void
  live: PrTabLive
  connected: boolean
}

// Desktop's checks-panel cadence (shared policy): 1 min while open, backing off to 2 min when nothing
// changes and up to 15 min on failures, stopping once a merged PR's checks settle. It runs only while
// the PR is on screen, its route is focused, the host is connected and the app is in the foreground.
export function useMobilePrPolling({ state, refetch, live, connected }: Input): {
  /** Polling is running for an open PR, so the screen can say "Live" instead of offering Refresh. */
  polling: boolean
} {
  const appActive = useAppActive()
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const pr = state.kind === 'ready' ? state.data.pr : null
  const checks = state.kind === 'ready' ? state.data.checks : null
  const checksError = state.kind === 'ready' ? state.data.checksError : null
  const [policy] = useState(() => new ChecksDetailPollingPolicy())
  const backoffRef = useRef(60_000)
  const signatureRef = useRef<string | null>(null)
  const lastAttemptRef = useRef<number | null>(null)
  const inFlightRef = useRef(false)
  // Each PR is its own generation, so a read started for the last PR cannot steer this one's cadence.
  const generationRef = useRef(0)
  const [tick, setTick] = useState(0)
  const refetchRef = useRef(refetch)
  useLayoutEffect(() => {
    refetchRef.current = refetch
  })

  const prNumber = pr?.number ?? null
  useEffect(() => {
    generationRef.current += 1
    policy.reset()
    backoffRef.current = 60_000
    signatureRef.current = null
    lastAttemptRef.current = null
  }, [policy, prNumber])

  // Every read that lands feeds the backoff: unchanged checks slow it, changes reset it, a failed checks read fails it.
  useEffect(() => {
    if (!checks) {
      return
    }
    if (checksError !== null) {
      policy.fail()
      backoffRef.current = nextChecksPollBackoffMs(backoffRef.current, 'failed')
      return
    }
    const signature = policy.accept(checks)
    backoffRef.current = nextChecksPollBackoffMs(
      backoffRef.current,
      signature === signatureRef.current ? 'unchanged' : 'changed'
    )
    signatureRef.current = signature
  }, [checks, checksError, policy])

  const running = live !== false && appActive && focused && connected && pr !== null
  const prState = pr?.state
  const checksStatus = pr?.checksStatus
  useEffect(() => {
    if (!running || !prState || inFlightRef.current) {
      return
    }
    const interval = policy.delayMs(prState, checksStatus, backoffRef.current)
    if (interval === null) {
      return
    }
    const now = Date.now()
    const last = lastAttemptRef.current
    // Coming back after the interval has passed refreshes at once, but never inside the cooldown.
    const delay =
      last === null
        ? interval
        : Math.max(last + interval - now, last + REVIEW_REFRESH_COOLDOWN_MS - now, 0)
    const generation = generationRef.current
    const timer = setTimeout(() => {
      lastAttemptRef.current = Date.now()
      inFlightRef.current = true
      void Promise.resolve(
        refetchRef.current({ includeDetails: live === 'details', background: true })
      )
        .then((result) => {
          if (generation !== generationRef.current) {
            return
          }
          // A skipped or superseded poll says nothing about the host, so only a failed read backs off.
          if (result === 'failed') {
            policy.fail()
            backoffRef.current = nextChecksPollBackoffMs(backoffRef.current, 'failed')
          }
        })
        .finally(() => {
          inFlightRef.current = false
          setTick((value) => value + 1)
        })
    }, delay)
    return () => clearTimeout(timer)
    // New data from any read (a manual refresh too) re-arms the timer with the backoff it just set.
  }, [checks, checksError, checksStatus, live, policy, prNumber, prState, running, tick])

  return { polling: running && (prState === 'open' || prState === 'draft') }
}
