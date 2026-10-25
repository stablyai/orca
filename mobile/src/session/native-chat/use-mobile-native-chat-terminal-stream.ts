import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { resolveMobileNativeChatTerminalStreamAction } from './mobile-native-chat-terminal-stream'

const MAX_REARM_ATTEMPTS = 3

// Require a stream to outlive the subscribed/end round-trip window before treating rearm as recovered.
const HEALTHY_STREAM_PROOF_MS = 5_000

export function useMobileNativeChatTerminalStream(args: {
  showNativeChat: boolean
  activeHandle: string | null
  activeTabType: string | null
  // Lease state must rerun reconciliation because mutable stream refs are invisible to React.
  leaseReady: boolean
  // Signal teardown even when the lease was already absent; dead PTYs may end without subscribed.
  streamRevision: number
  subscriptionsRef: MutableRefObject<Map<string, () => void>>
  subscribingRef: MutableRefObject<Set<string>>
  leaseOnlyRef: MutableRefObject<Set<string>>
  webReadyRef: MutableRefObject<Set<string>>
  subscribe: (handle: string) => void
  unsubscribe: (handle: string) => void
}): {
  notifyWebReady: (handle: string, wasAlreadyReady: boolean) => void
  notifyListedHandles: (liveHandles: ReadonlySet<string>) => void
  hasTabsRecoveryNeed: () => boolean
} {
  const coveredHandleRef = useRef<string | null>(null)
  const rearmAttemptsRef = useRef<Map<string, number>>(new Map())
  // Only actual list absence followed by return grants a fresh rearm budget.
  const absentSinceExhaustionRef = useRef<Set<string>>(new Set())
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
      // Reconcile readiness only when it can release chat’s lease-only stream; normal ready handling skips live subscriptions.
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
      // Refill exhausted rearms only after list absence and return; still-listed dead PTYs must not renew their own loop.
      const handle = coveredHandleRef.current
      if (handle == null) {
        return
      }
      if (!liveHandles.has(handle)) {
        absentSinceExhaustionRef.current.add(handle)
        return
      }
      // Consume absence only when it buys a refill; using it early can strand a later exhausted handle.
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
    // Invalidate recovery proof whenever its covered stream is no longer the live one.
    if (!streamHolding || healthyStreamProofRef.current?.handle !== handle) {
      cancelHealthyStreamProof()
    }
    if (!handle) {
      return
    }
    if (action === 'none') {
      // Subscribed can precede immediate end; refill only after sustained stream liveness proves recovery.
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
      // Bound subscribed/end rearms on dead PTYs; each otherwise spends host waits and tab-mount requests forever.
      const attempts = rearmAttemptsRef.current.get(handle) ?? 0
      if (attempts >= MAX_REARM_ATTEMPTS) {
        return
      }
      args.subscribe(handle)
      // A locally gated subscribe never reached the host and spends no attempt.
      if (args.subscribingRef.current.has(handle) || args.subscriptionsRef.current.has(handle)) {
        rearmAttemptsRef.current.set(handle, attempts + 1)
      }
      return
    }
    if (action === 'pause') {
      coveredHandleRef.current = handle
      forgetRearmState(handle)
      // Covered chat needs the input lease without duplicate PTY output; replace view streams with lease-only ones.
      if (streamActive) {
        args.unsubscribe(handle)
      }
      args.subscribe(handle)
      return
    }
    if (coveredHandleRef.current === handle || streamIsLeaseOnly) {
      args.unsubscribe(handle)
      coveredHandleRef.current = null
    }
    args.subscribe(handle)
  }, [
    args.activeHandle,
    args.activeTabType,
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
  // Memoize the stable callback bundle so route dependencies do not rebuild on every keystroke.
  return useMemo(
    () => ({ notifyWebReady, notifyListedHandles, hasTabsRecoveryNeed }),
    [hasTabsRecoveryNeed, notifyListedHandles, notifyWebReady]
  )
}
