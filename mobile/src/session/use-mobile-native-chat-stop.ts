import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  hasMobileNativeChatStopCleanup,
  recoverMobileNativeChatStopCleanup,
  rememberMobileNativeChatStopCleanup
} from './mobile-native-chat-stop-cleanup'
import {
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { requestMobileNativeChatStopLease } from './mobile-native-chat-stop-lease'

const ESCAPE = String.fromCharCode(27)
const CODEX_STOP_BACKGROUND_TERMINALS = '/stop'
const STOP_STEP_DELAY_MS = 80

type StopRoute = {
  readonly agent: string | null
  readonly sessionId: string | null
  readonly streamIdentity: string
  readonly terminal: string | null
}

export function useMobileNativeChatStop(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  agentRef: MutableRefObject<string | null>
  sessionId: string | null
  streamIdentity: string
  cancelPending: () => void
  onSendError: (message: string) => void
}): () => void {
  const {
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef,
    sessionId,
    streamIdentity,
    cancelPending,
    onSendError
  } = args
  const mountedRef = useRef(false)
  const activeRouteRef = useRef<StopRoute>({
    agent: agentRef.current,
    sessionId,
    streamIdentity,
    terminal: handleRef.current
  })
  useLayoutEffect(() => {
    activeRouteRef.current = {
      agent: agentRef.current,
      sessionId,
      streamIdentity,
      terminal: handleRef.current
    }
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isVisibleOriginal = useCallback(
    (target: StopRoute): boolean => {
      if (!mountedRef.current) {
        return false
      }
      const active = activeRouteRef.current
      return (
        active.terminal === target.terminal &&
        agentRef.current === target.agent &&
        (target.sessionId
          ? active.sessionId === target.sessionId
          : active.streamIdentity === target.streamIdentity)
      )
    },
    [agentRef]
  )

  const hasReplacementOnTerminal = useCallback(
    (target: StopRoute): boolean => {
      if (!mountedRef.current) {
        return false
      }
      const active = activeRouteRef.current
      if (active.terminal !== target.terminal) {
        return false
      }
      return (
        agentRef.current !== target.agent ||
        (target.sessionId
          ? active.sessionId !== target.sessionId
          : active.streamIdentity !== target.streamIdentity)
      )
    },
    [agentRef]
  )

  const recoverPendingCleanup = useCallback(async (): Promise<void> => {
    const terminal = handleRef.current
    if (
      !client ||
      !enabled ||
      !terminal ||
      agentRef.current !== 'codex' ||
      !hasMobileNativeChatStopCleanup(streamIdentity)
    ) {
      return
    }
    const target: StopRoute = {
      agent: 'codex',
      sessionId,
      streamIdentity,
      terminal
    }
    const outcome = await recoverMobileNativeChatStopCleanup({
      client,
      deviceToken: deviceTokenRef.current,
      sessionId,
      shouldSend: () => !hasReplacementOnTerminal(target),
      streamIdentity,
      terminal
    })
    if (!isVisibleOriginal(target)) {
      return
    }
    if (outcome === 'rejected') {
      onSendError(
        'Agent interrupted; background cleanup still pending — reconnect or return to this chat to retry'
      )
    } else if (outcome === 'unknown') {
      onSendError('Agent interrupted; background cleanup unconfirmed — check chat before retrying')
    }
  }, [
    agentRef,
    client,
    deviceTokenRef,
    enabled,
    handleRef,
    hasReplacementOnTerminal,
    isVisibleOriginal,
    onSendError,
    sessionId,
    streamIdentity
  ])

  useEffect(() => {
    void recoverPendingCleanup()
  }, [recoverPendingCleanup])

  return useCallback(() => {
    const terminal = handleRef.current
    if (!client || !enabled || !terminal) {
      onSendError('Stop not sent (terminal not ready)')
      return
    }
    if (hasMobileNativeChatStopCleanup(streamIdentity)) {
      void recoverPendingCleanup()
      return
    }
    const request = requestMobileNativeChatStopLease(terminal)
    if (!request) {
      return
    }
    const target: StopRoute = {
      agent: agentRef.current,
      sessionId,
      streamIdentity,
      terminal
    }
    const deviceToken = deviceTokenRef.current
    const send = (
      text: string,
      enter: boolean,
      deadline: number
    ): Promise<MobileNativeChatSendOutcome> =>
      sendMobileNativeChatMessageWithOutcome({
        client,
        terminal,
        text,
        enter,
        deadline,
        ...(deviceToken ? { mobileClient: { id: deviceToken, type: 'mobile' as const } } : {})
      })
    const waitForNextStep = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, STOP_STEP_DELAY_MS))
    const rememberCleanup = (): boolean =>
      rememberMobileNativeChatStopCleanup({
        sessionId: target.sessionId,
        streamIdentity: target.streamIdentity,
        terminal
      })

    void (async () => {
      const lease = await request.acquired
      if (!lease) {
        return
      }
      try {
        if (hasReplacementOnTerminal(target)) {
          return
        }
        try {
          cancelPending()
        } catch {
          if (isVisibleOriginal(target)) {
            onSendError('Stop not sent')
          }
          return
        }
        const interruptDeadline = openMobileNativeChatSendBudget()
        const firstEscape = send(ESCAPE, false, interruptDeadline)
        await waitForNextStep()
        if (hasReplacementOnTerminal(target)) {
          if ((await firstEscape) === 'accepted' && target.agent === 'codex') {
            rememberCleanup()
          }
          return
        }
        const escapes = await Promise.all([firstEscape, send(ESCAPE, false, interruptDeadline)])
        if (!escapes.includes('accepted')) {
          if (isVisibleOriginal(target)) {
            onSendError(
              escapes.includes('unknown')
                ? 'Stop unconfirmed — check chat before retrying'
                : 'Stop not sent'
            )
          }
          return
        }
        if (target.agent !== 'codex') {
          return
        }
        await waitForNextStep()
        if (hasReplacementOnTerminal(target)) {
          rememberCleanup()
          return
        }
        const cleanup = await send(
          CODEX_STOP_BACKGROUND_TERMINALS,
          true,
          openMobileNativeChatSendBudget()
        )
        if (cleanup === 'rejected') {
          const pending = rememberCleanup()
          if (isVisibleOriginal(target)) {
            onSendError(
              pending
                ? 'Agent interrupted; background cleanup pending — reconnect or return to this chat to retry'
                : 'Agent interrupted; background cleanup not sent — return to this chat and send /stop'
            )
          }
        } else if (cleanup === 'unknown' && isVisibleOriginal(target)) {
          onSendError(
            'Agent interrupted; background cleanup unconfirmed — check chat before retrying'
          )
        }
      } finally {
        lease.release()
      }
    })()
  }, [
    agentRef,
    cancelPending,
    client,
    deviceTokenRef,
    enabled,
    handleRef,
    hasReplacementOnTerminal,
    isVisibleOriginal,
    onSendError,
    recoverPendingCleanup,
    sessionId,
    streamIdentity
  ])
}
