import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { mobileNativeChatOperationTarget } from './mobile-native-chat-operation-target'
import { openMobileNativeChatSendBudget } from './mobile-native-chat-send'

export function useMobileNativeChatStop(args: {
  operations: HostSessionNativeChatOperations | null
  workspaceId: string
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  streamIdentity: string
  cancelPending: () => void
  onSendError: (message: string) => void
}): () => void {
  const {
    operations,
    workspaceId,
    enabled,
    handleRef,
    deviceTokenRef,
    streamIdentity,
    cancelPending,
    onSendError
  } = args
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  /** Settles the paced second Escape when it is cancelled rather than sent, so a
   *  first-Escape failure still reports instead of waiting on a write that will
   *  never happen. */
  const dropSecondEscapeRef = useRef<(() => void) | null>(null)
  const activeRouteRef = useRef({ operations, enabled, streamIdentity })
  // The paced Escape timer must read the last committed route synchronously.
  useLayoutEffect(() => {
    activeRouteRef.current = { operations, enabled, streamIdentity }
  }, [operations, enabled, streamIdentity])
  const cancelSecondEscape = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const drop = dropSecondEscapeRef.current
    dropSecondEscapeRef.current = null
    drop?.()
  }, [])
  useEffect(
    () => () => {
      generationRef.current += 1
      cancelSecondEscape()
    },
    [cancelSecondEscape, operations, enabled, streamIdentity]
  )
  return useCallback(() => {
    const handle = handleRef.current
    if (!operations || !handle || !enabled) {
      onSendError('Stop not sent (terminal not ready)')
      return
    }
    cancelPending()
    generationRef.current += 1
    const generation = generationRef.current
    cancelSecondEscape()
    const stopStreamIdentity = streamIdentity
    const deadline = openMobileNativeChatSendBudget()
    // Why: the two paced Escapes are one user action. Reporting the first one's
    // failure the moment it lands told the user a stop failed that the second
    // Escape then completed — and a second Stop press writes into changed prompt
    // state. Hold the verdict until both have settled, then stay quiet if either
    // was accepted. `pending` starts at 1 for the Escape still on its timer.
    let pending = 1
    let sawAccepted = false
    let sawUnknown = false
    let sawRejected = false
    const reportIfSettled = (): void => {
      if (
        generationRef.current !== generation ||
        pending > 0 ||
        sawAccepted ||
        (!sawUnknown && !sawRejected)
      ) {
        return
      }
      // Why: an ack lost after the frame was written (or a logical cutover) may
      // still have stopped the agent — a definite "not sent" would invite a second
      // Escape into changed state. Mirrors the cancel/answer wording.
      onSendError(sawUnknown ? 'Stop unconfirmed — check chat before retrying' : 'Stop not sent')
    }
    const sendEscape = (): void => {
      const activeRoute = activeRouteRef.current
      if (
        !activeRoute.enabled ||
        activeRoute.operations !== operations ||
        activeRoute.streamIdentity !== stopStreamIdentity ||
        handleRef.current !== handle
      ) {
        return
      }
      pending += 1
      // The shared budget bounds the write so a stale Escape cannot land minutes
      // later into a composer that by then holds fresh text.
      void operations
        .stop(
          mobileNativeChatOperationTarget({
            workspaceId,
            terminalId: handle,
            clientId: deviceTokenRef.current
          }),
          deadline
        )
        .then((outcome) => {
          if (outcome === 'accepted') {
            sawAccepted = true
          } else if (outcome === 'unknown') {
            // Delivery-ambiguous: the Escape may still have stopped the agent.
            sawUnknown = true
          } else {
            sawRejected = true
          }
        })
        // Why: disconnect can race either fire-and-forget Escape; record one verdict
        // instead of leaking an unhandled rejection.
        .catch(() => {
          sawRejected = true
        })
        .finally(() => {
          pending -= 1
          reportIfSettled()
        })
    }
    sendEscape()
    dropSecondEscapeRef.current = () => {
      pending -= 1
      reportIfSettled()
    }
    // Why: two paced Escape bytes reliably stop TUIs without remote coalescing.
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      dropSecondEscapeRef.current = null
      sendEscape()
      pending -= 1
      reportIfSettled()
    }, 80)
  }, [
    cancelPending,
    cancelSecondEscape,
    deviceTokenRef,
    enabled,
    handleRef,
    onSendError,
    operations,
    streamIdentity,
    workspaceId
  ])
}
