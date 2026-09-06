import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import { openMobileNativeChatSendBudget } from './mobile-native-chat-send'

const STOP_STEP_MS = 80

export function useMobileNativeChatStop(args: {
  operations: HostSessionNativeChatOperations | null
  enabled: boolean
  targetRef: MutableRefObject<HostSessionNativeChatTarget | null>
  streamIdentity: string
  cancelPending: () => void
  onSendError: (message: string) => void
}): () => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  const dropSecondEscapeRef = useRef<(() => void) | null>(null)
  const activeRouteRef = useRef({
    operations: args.operations,
    enabled: args.enabled,
    streamIdentity: args.streamIdentity
  })
  useEffect(() => {
    activeRouteRef.current = {
      operations: args.operations,
      enabled: args.enabled,
      streamIdentity: args.streamIdentity
    }
  }, [args.enabled, args.operations, args.streamIdentity])

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
    [args.enabled, args.operations, args.streamIdentity, cancelSecondEscape]
  )

  return useCallback(() => {
    const target = args.targetRef.current
    const operations = args.operations
    if (!operations || !target || !args.enabled) {
      args.onSendError('Stop not sent (terminal not ready)')
      return
    }
    args.cancelPending()
    generationRef.current += 1
    const generation = generationRef.current
    cancelSecondEscape()
    const streamIdentity = args.streamIdentity
    const deadline = openMobileNativeChatSendBudget()
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
      args.onSendError(
        sawUnknown ? 'Stop unconfirmed — check chat before retrying' : 'Stop not sent'
      )
    }
    const sendEscape = (): void => {
      const activeRoute = activeRouteRef.current
      if (
        !activeRoute.enabled ||
        activeRoute.operations !== operations ||
        activeRoute.streamIdentity !== streamIdentity ||
        args.targetRef.current !== target
      ) {
        return
      }
      pending += 1
      void operations
        .stop(target, deadline)
        .then((outcome) => {
          if (outcome === 'accepted') {
            sawAccepted = true
          } else if (outcome === 'unknown') {
            sawUnknown = true
          } else {
            sawRejected = true
          }
        })
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
    }, STOP_STEP_MS)
  }, [
    args.cancelPending,
    args.enabled,
    args.onSendError,
    args.operations,
    args.streamIdentity,
    args.targetRef,
    cancelSecondEscape
  ])
}
