import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import { openMobileNativeChatSendBudget } from './mobile-native-chat-send'
import { t } from '@/i18n/mobile-i18n'

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
  /** Settles the paced second Escape when it is cancelled rather than sent, so a
   *  first-Escape failure still reports instead of waiting on a write that will
   *  never happen. */
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
      onSendError(t('m.ZhefrDE'))
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
      onSendError(sawUnknown ? t('m.i8UxPTM') : t('m.S9MYUPk'))
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
      void client
        .sendRequest(
          'terminal.send',
          {
            terminal: handle,
            text: String.fromCharCode(27),
            ...(deviceTokenRef.current
              ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
              : {})
          },
          // Why: without this the call parks indefinitely on reconnect, so "Stop not
          // sent" never appears and a stale Escape can land minutes later — into a
          // composer that by then holds fresh text.
          { timeoutMs, budgetSpansConnect: true }
        )
        .then((response) => {
          if (isTerminalSendRpcAccepted(response)) {
            sawAccepted = true
          } else {
            sawRejected = true
          }
        })
        // Why: disconnect can race either fire-and-forget Escape; record one verdict
        // instead of leaking an unhandled RPC rejection.
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
    client,
    deviceTokenRef,
    enabled,
    handleRef,
    onSendError,
    streamIdentity
  ])
}
