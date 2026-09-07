import { useCallback, useEffect, useRef, type RefObject } from 'react'

// Why: long enough for a suspended document to wake and answer, short enough that a
// genuinely dead engine still reaches the error overlay promptly.
export const WEB_READY_PROBE_GRACE_MS = 2500

// Why: iOS can hand back a live document whose ready signal was lost in a transition —
// an app switch cures that instantly through ping/pong, while reloading reproduces the
// wedge. Ping the document first and fall back only when the grace window expires.
export function useTerminalWebViewPingProbe(
  isWebReadyRef: RefObject<boolean>,
  sendPing: () => void
) {
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probeGiveUpRef = useRef<(() => void) | null>(null)
  const probeNotifyParentRef = useRef(false)

  const cancelPingProbe = useCallback(() => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current)
      probeTimerRef.current = null
    }
    probeGiveUpRef.current = null
  }, [])

  // Why: `isRecoveredRef` names the signal that proves this probe's cure. The paint probe
  // runs on a document that is already web-ready, so judging it by liveness would silence
  // its give-up forever; it watches the painted surface instead.
  const attemptPingRecovery = useCallback(
    (notifyParent: boolean, onGiveUp: () => void, isRecoveredRef?: RefObject<boolean>) => {
      cancelPingProbe()
      probeNotifyParentRef.current = notifyParent
      probeGiveUpRef.current = onGiveUp
      const recoveredRef = isRecoveredRef ?? isWebReadyRef
      sendPing()
      probeTimerRef.current = setTimeout(() => {
        probeTimerRef.current = null
        const giveUp = probeGiveUpRef.current
        probeGiveUpRef.current = null
        if (!recoveredRef.current) {
          giveUp?.()
        }
      }, WEB_READY_PROBE_GRACE_MS)
    },
    [cancelPingProbe, isWebReadyRef, sendPing]
  )

  // Why: foreground recovery resubscribes on its own, so its ping must not
  // double-notify the parent, and it supersedes any in-flight probe.
  const markRecoveryPing = useCallback(() => {
    cancelPingProbe()
    probeNotifyParentRef.current = false
  }, [cancelPingProbe])

  // Why: an armed probe outlives the pane by up to the grace window, and its give-up
  // reports an engine error or reloads a WebView the unmounted owner no longer has.
  useEffect(() => cancelPingProbe, [cancelPingProbe])

  const takeProbeNotifyParent = useCallback(() => {
    const notifyParent = probeNotifyParentRef.current
    probeNotifyParentRef.current = false
    return notifyParent
  }, [])

  return { attemptPingRecovery, cancelPingProbe, markRecoveryPing, takeProbeNotifyParent }
}
