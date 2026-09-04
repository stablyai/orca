import { useCallback, useRef, type RefObject } from 'react'

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

  const attemptPingRecovery = useCallback(
    (notifyParent: boolean, onGiveUp: () => void) => {
      cancelPingProbe()
      probeNotifyParentRef.current = notifyParent
      probeGiveUpRef.current = onGiveUp
      sendPing()
      probeTimerRef.current = setTimeout(() => {
        probeTimerRef.current = null
        const giveUp = probeGiveUpRef.current
        probeGiveUpRef.current = null
        if (!isWebReadyRef.current) {
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

  const takeProbeNotifyParent = useCallback(() => {
    const notifyParent = probeNotifyParentRef.current
    probeNotifyParentRef.current = false
    return notifyParent
  }, [])

  return { attemptPingRecovery, cancelPingProbe, markRecoveryPing, takeProbeNotifyParent }
}
