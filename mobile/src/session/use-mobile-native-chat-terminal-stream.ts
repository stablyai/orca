import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { resolveMobileNativeChatTerminalStreamAction } from './mobile-native-chat-terminal-stream'

/** Enough to ride out a transient teardown without spinning on a dead PTY. */
const MAX_REARM_ATTEMPTS = 3

/** A dead PTY's `end` follows its `subscribed` within one host round trip, so a
 *  stream still up this long after the ack is one that actually recovered. */
const HEALTHY_STREAM_PROOF_MS = 5_000

/** Pauses the active terminal stream while native chat covers its mounted WebView,
 *  then resumes from a fresh scrollback snapshot when terminal view returns. */
export function useMobileNativeChatTerminalStream(args: {
  showNativeChat: boolean
  activeHandle: string | null
  activeTabType: string | null
  /** Reactive lease state — losing it must re-run this effect, since the refs it
   *  reads for stream liveness are invisible to React. */
  leaseReady: boolean
  /** Bumped whenever a covered stream is torn down. The lease alone can't carry
   *  that signal: a dead PTY can emit `end` with no preceding `subscribed`, so
   *  clearing an already-absent lease is a no-op and nothing would re-run. */
  streamRevision: number
  subscriptionsRef: MutableRefObject<Map<string, () => void>>
  subscribingRef: MutableRefObject<Set<string>>
  /** Handles whose current subscribe went out as an input lease only. */
  leaseOnlyRef: MutableRefObject<Set<string>>
  webReadyRef: MutableRefObject<Set<string>>
  initializedRef: MutableRefObject<Set<string>>
  subscribe: (handle: string) => void
  unsubscribe: (handle: string) => void
}): {
  notifyWebReady: (handle: string, wasAlreadyReady: boolean) => void
  notifyListedHandles: (liveHandles: ReadonlySet<string>) => void
  /** True while an exhausted, absent handle still needs a replacement tab snapshot. */
  hasTabsRecoveryNeed: () => boolean
} {
  const coveredHandleRef = useRef<string | null>(null)
  const rearmAttemptsRef = useRef<Map<string, number>>(new Map())
  /** Handles `terminal.list` has omitted since we last saw them. Only a handle that
   *  actually went away and came back earns a fresh rearm budget. */
  const absentSinceExhaustionRef = useRef<Set<string>>(new Set())
  /** Pending proof that a rearmed stream outlived the dead-PTY teardown window. */
  const healthyStreamProofRef = useRef<{
    handle: string
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const [webReadyRevision, setWebReadyRevision] = useState(0)
  const [rearmBudgetRevision, setRearmBudgetRevision] = useState(0)
  const forgetRearmState = useCallback((handle: string) => {
    rearmAttemptsRef.current.delete(handle)
    absentSinceExhaustionRef.current.delete(handle)
  }, [])
  const cancelHealthyStreamProof = useCallback(() => {
    if (healthyStreamProofRef.current) {
      clearTimeout(healthyStreamProofRef.current.timer)
      healthyStreamProofRef.current = null
    }
  }, [])
  const notifyWebReady = useCallback(
    (handle: string, wasAlreadyReady: boolean) => {
      // Why: ordinary WebView startups must not rerender the large session route;
      // only readiness that can release a native-chat lease needs reconciliation.
      // A lease-only stream counts: the route's own web-ready path bails on any live
      // subscription, so nothing else would ever trade that lease for output.
      if (
        !wasAlreadyReady &&
        (coveredHandleRef.current === handle || args.leaseOnlyRef.current.has(handle))
      ) {
        setWebReadyRevision((revision) => revision + 1)
      }
    },
    [args.leaseOnlyRef]
  )
  const notifyListedHandles = useCallback(
    (liveHandles: ReadonlySet<string>) => {
      // Why: the rearm budget bounds one teardown, not the handle's lifetime. A covered
      // handle the host drops and then reports again may have a live PTY once more, so
      // spend a fresh budget instead of leaving the composer locked until leave-chat
      // (#10681).
      //
      // The absence is required, not incidental: a dead PTY that stays listed answers
      // every subscribe with `subscribed`+`end`, so refilling merely because the handle
      // is present now would hand that loop a new budget on each list refresh and undo
      // the bound this hook exists to enforce.
      const handle = coveredHandleRef.current
      if (handle == null) {
        return
      }
      if (!liveHandles.has(handle)) {
        absentSinceExhaustionRef.current.add(handle)
        return
      }
      // Why: consume the absence marker only when it actually buys a refill. Spending
      // it on a below-threshold check left the handle with nothing to trade once the
      // budget did run out, and a still-listed handle never goes absent again — the
      // permanent lock the marker exists to prevent.
      if ((rearmAttemptsRef.current.get(handle) ?? 0) < MAX_REARM_ATTEMPTS) {
        return
      }
      if (!absentSinceExhaustionRef.current.delete(handle)) {
        return
      }
      forgetRearmState(handle)
      setRearmBudgetRevision((revision) => revision + 1)
    },
    [forgetRearmState]
  )
  const hasTabsRecoveryNeed = useCallback((): boolean => {
    // Keep polling until a replacement handle arrives; an equal cached snapshot
    // must not consume recovery and strand the composer on the dead handle.
    const handle = coveredHandleRef.current
    return (
      handle != null &&
      absentSinceExhaustionRef.current.has(handle) &&
      (rearmAttemptsRef.current.get(handle) ?? 0) >= MAX_REARM_ATTEMPTS
    )
  }, [])
  const reconcileStream = useCallback(() => {
    const handle = args.activeHandle
    if (coveredHandleRef.current && coveredHandleRef.current !== handle) {
      forgetRearmState(coveredHandleRef.current)
      coveredHandleRef.current = null
    }
    const streamActive =
      handle != null &&
      (args.subscriptionsRef.current.has(handle) || args.subscribingRef.current.has(handle))
    const streamIsLeaseOnly =
      streamActive && handle != null && args.leaseOnlyRef.current.has(handle)
    const action = resolveMobileNativeChatTerminalStreamAction({
      showNativeChat: args.showNativeChat,
      activeHandle: handle,
      activeTabType: args.activeTabType,
      streamActive,
      streamCovered: coveredHandleRef.current === handle,
      streamIsLeaseOnly,
      webViewReady: handle != null && args.webReadyRef.current.has(handle)
    })
    const streamHolding = action === 'none' && streamActive && coveredHandleRef.current === handle
    // Any pass that isn't "this covered stream is still up" invalidates a pending
    // proof — the stream it was vouching for is gone or being replaced.
    if (!streamHolding || healthyStreamProofRef.current?.handle !== handle) {
      cancelHealthyStreamProof()
    }
    if (!handle) {
      return
    }
    if (action === 'none') {
      // Why: `subscribed` is the FIRST half of a dead PTY's reply (`subscribed` then
      // `end`), and it re-runs this effect with the stream momentarily up. Clearing
      // the budget there handed every dead-PTY pass a fresh one, so the resubscribe
      // loop this hook exists to bound ran forever. Only a stream still up after the
      // `end` would have landed proves the last rearm took.
      if (streamHolding && !healthyStreamProofRef.current && rearmAttemptsRef.current.has(handle)) {
        healthyStreamProofRef.current = {
          handle,
          timer: setTimeout(() => {
            healthyStreamProofRef.current = null
            forgetRearmState(handle)
          }, HEALTHY_STREAM_PROOF_MS)
        }
      }
      return
    }
    if (action === 'rearm') {
      // Why: the host answers a handle whose PTY is gone with `subscribed`+`end`,
      // which drops the lease again — an unbounded resubscribe loop, each pass
      // costing a 10s host wait and a desktop tab-mount request (#10681). Give up
      // after a few tries and leave the composer honestly locked.
      const attempts = rearmAttemptsRef.current.get(handle) ?? 0
      if (attempts >= MAX_REARM_ATTEMPTS) {
        return
      }
      args.subscribe(handle)
      // Why: a subscribe turned away by its own gates (no client, no webview yet)
      // never reached the host, so charging it an attempt would spend the budget on
      // nothing and could exhaust it before a single real rearm was tried.
      if (args.subscribingRef.current.has(handle) || args.subscriptionsRef.current.has(handle)) {
        rearmAttemptsRef.current.set(handle, attempts + 1)
      }
      return
    }
    if (action === 'pause') {
      coveredHandleRef.current = handle
      forgetRearmState(handle)
      // Why: returning to terminal must accept the fresh scrollback snapshot;
      // the stream was paused while chat covered output that xterm never saw.
      args.initializedRef.current.delete(handle)
      // Why: covered chat needs the input-floor lease without paying to stream
      // duplicate PTY output. Replace any view stream with a lease-only stream.
      if (streamActive) {
        args.unsubscribe(handle)
      }
      args.subscribe(handle)
      return
    }
    if (coveredHandleRef.current === handle || streamIsLeaseOnly) {
      // Why clear `initialized`: a lease-only stream delivered no scrollback, so xterm
      // holds nothing — a stale mark would drop the replacement snapshot and the
      // terminal would stay blank through the resubscribe.
      args.initializedRef.current.delete(handle)
      args.unsubscribe(handle)
      coveredHandleRef.current = null
    }
    args.subscribe(handle)
  }, [
    args.activeHandle,
    args.activeTabType,
    args.initializedRef,
    args.leaseOnlyRef,
    args.leaseReady,
    args.showNativeChat,
    args.streamRevision,
    args.subscribe,
    args.subscribingRef,
    args.subscriptionsRef,
    args.unsubscribe,
    args.webReadyRef,
    cancelHealthyStreamProof,
    forgetRearmState,
    rearmBudgetRevision,
    webReadyRevision
  ])
  useEffect(() => reconcileStream(), [reconcileStream])
  useEffect(() => cancelHealthyStreamProof, [cancelHealthyStreamProof])
  // Why memoized: the session route keeps this object in callback dep arrays, and a
  // fresh literal per render would rebuild them on every keystroke. All three members
  // are already stable, so this reference never changes.
  return useMemo(
    () => ({ notifyWebReady, notifyListedHandles, hasTabsRecoveryNeed }),
    [hasTabsRecoveryNeed, notifyListedHandles, notifyWebReady]
  )
}
