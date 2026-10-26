import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { nativeChatTerminalWrite } from './mobile-session-write-operations'
import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { openMobileNativeChatSendBudget } from './mobile-native-chat-send'

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
  const generationRef = useRef(0)
  // Settle a cancelled second Escape so first-write failure cannot wait forever for an unsent write.
  const dropSecondEscapeRef = useRef<(() => void) | null>(null)
  const activeRouteRef = useRef({ client, enabled, streamIdentity })
  activeRouteRef.current = { client, enabled, streamIdentity }
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
    [cancelSecondEscape, client, enabled, streamIdentity]
  )
  return useCallback(() => {
    const handle = handleRef.current
    if (!client || !handle || !enabled) {
      onSendError('Stop not sent (terminal not ready)')
      return
    }
    cancelPending()
    generationRef.current += 1
    const generation = generationRef.current
    cancelSecondEscape()
    const stopStreamIdentity = streamIdentity
    const deadline = openMobileNativeChatSendBudget()
    // Wait for both paced Escapes and report failure only if neither was accepted; one Stop must not invite another after either key changed prompt state.
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
      // Lost-ack/cutover Escape may have stopped work; report uncertainty instead of inviting a second key.
      onSendError(sawUnknown ? 'Stop unconfirmed — check chat before retrying' : 'Stop not sent')
    }
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
      pending += 1
      const timeoutMs = deadline - Date.now()
      if (timeoutMs <= 0) {
        sawRejected = true
        pending -= 1
        reportIfSettled()
        return
      }
      void nativeChatTerminalWrite
        .request(
          client,
          {
            terminal: handle,
            text: String.fromCharCode(27),
            ...(deviceTokenRef.current
              ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
              : {})
          },
          // Bound reconnect wait so stale Escape cannot arrive minutes later in a fresh composer.
          { timeoutMs, budgetSpansConnect: true }
        )
        .then((response) => {
          if (nativeChatTerminalWrite.interpret(response) === true) {
            sawAccepted = true
            // A deliberate Stop is human input; it takes the worker over like any other key.
            reportWorkerTerminalUserInput(client, handle)
          } else {
            sawRejected = true
          }
        })
        // Both fire-and-forget Escapes settle into one verdict, including disconnect races.
        .catch((error: unknown) => {
          if (isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)) {
            sawUnknown = true
          } else {
            sawRejected = true
          }
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
    // Pace Escape bytes so remote input cannot coalesce them away.
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
    client,
    deviceTokenRef,
    enabled,
    handleRef,
    onSendError,
    streamIdentity
  ])
}
