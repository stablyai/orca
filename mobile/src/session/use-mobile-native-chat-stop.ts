import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'

export function useMobileNativeChatStop(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  streamIdentity: string
  cancelPending: () => void
  onSendError: (message: string) => void
}): () => void {
  const { client, enabled, handleRef, deviceTokenRef, streamIdentity, cancelPending, onSendError } =
    args
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRouteRef = useRef({ client, enabled, streamIdentity })
  activeRouteRef.current = { client, enabled, streamIdentity }
  useEffect(() => {
    if (!enabled && timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [client, enabled, streamIdentity])
  return useCallback(() => {
    const handle = handleRef.current
    if (!client || !handle || !enabled) {
      onSendError('Stop not sent (terminal not ready)')
      return
    }
    cancelPending()
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    const stopStreamIdentity = streamIdentity
    let failureReported = false
    const sendEscape = (): void => {
      const activeRoute = activeRouteRef.current
      if (
        !activeRoute.enabled ||
        activeRoute.client !== client ||
        activeRoute.streamIdentity !== stopStreamIdentity ||
        handleRef.current !== handle
      ) {
        return
      }
      void client
        .sendRequest('terminal.send', {
          terminal: handle,
          text: String.fromCharCode(27),
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {})
        })
        .catch(() => {
          // Why: disconnect can race either fire-and-forget Escape; surface one
          // failure instead of leaking an unhandled RPC rejection.
          if (!failureReported) {
            failureReported = true
            onSendError('Stop not sent')
          }
        })
    }
    sendEscape()
    // Why: two paced Escape bytes reliably stop TUIs without remote coalescing.
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      sendEscape()
    }, 80)
  }, [cancelPending, client, deviceTokenRef, enabled, handleRef, onSendError, streamIdentity])
}
