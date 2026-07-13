import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS,
  MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS
} from './mobile-native-chat-answer-stepping'
import { sendMobileNativeChatMessage } from './mobile-native-chat-send'
import { shouldStepNativeChatAskAnswer } from '../../../src/shared/native-chat-agent-support'

/** Sends an AskUserQuestion answer to the active chat pane, with Claude's
 *  multi-step stepping. Extracted from the session route to keep that file under
 *  its line cap and to own the pending-timer lifecycle in one place. */
export type MobileNativeChatAnswerSend = {
  /** Answer the current question(s). Multi-line Claude answers step per question
   *  (body then a delayed Enter); single-line / non-Claude send one body + Enter. */
  answerAsk: (text: string) => Promise<boolean>
  /** Drop any in-flight per-question writes (call on Stop). */
  cancelPending: () => void
}

/**
 * Owns the per-question answer-send sequence for the mobile native chat. Reads
 * the live pane/agent through refs (the route already keeps them current) so the
 * returned callbacks stay stable. The scheduled setTimeout chain is cancelled on
 * a new answer, on `cancelPending` (Stop), and on unmount / session swap — so a
 * detached chain can never write PTY bytes to a stale pane.
 */
export function useMobileNativeChatAnswerSend(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  agentRef: MutableRefObject<string | null>
  /** Changes on chat session swap; cancels pending writes when it does. */
  sessionId: string | null
  streamIdentity: string
  onSendError: (message: string) => void
}): MobileNativeChatAnswerSend {
  const {
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef,
    sessionId,
    streamIdentity,
    onSendError
  } = args
  const generationRef = useRef(0)
  const activeRouteRef = useRef({ client, enabled, sessionId, streamIdentity })
  activeRouteRef.current = { client, enabled, sessionId, streamIdentity }
  const delaysRef = useRef<
    Set<{ timer: ReturnType<typeof setTimeout>; resolve: (completed: boolean) => void }>
  >(new Set())

  const cancelPending = useCallback(() => {
    generationRef.current += 1
    for (const delay of delaysRef.current) {
      clearTimeout(delay.timer)
      delay.resolve(false)
    }
    delaysRef.current.clear()
  }, [])

  // Cancel pending writes on unmount and whenever the chat session swaps.
  useEffect(() => {
    if (!enabled) {
      cancelPending()
    }
    return cancelPending
  }, [client, enabled, sessionId, streamIdentity, cancelPending])

  const answerAsk = useCallback(
    async (text: string): Promise<boolean> => {
      const handle = handleRef.current
      if (!client || !handle || !enabled) {
        onSendError('Answer not sent (disconnected)')
        return false
      }
      // A new answer supersedes any still-pending per-question writes.
      cancelPending()
      const generation = generationRef.current
      const sendTerminal = (body: string, enter: boolean): Promise<boolean> => {
        const activeRoute = activeRouteRef.current
        if (
          !activeRoute.enabled ||
          activeRoute.client !== client ||
          activeRoute.sessionId !== sessionId ||
          activeRoute.streamIdentity !== streamIdentity ||
          handleRef.current !== handle
        ) {
          return Promise.resolve(false)
        }
        return sendMobileNativeChatMessage({
          client,
          terminal: handle,
          text: body,
          enter,
          ...(deviceTokenRef.current
            ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
            : {})
        })
      }
      const wait = (ms: number): Promise<boolean> =>
        new Promise((resolve) => {
          const delay = {
            timer: setTimeout(() => {
              delaysRef.current.delete(delay)
              resolve(generationRef.current === generation)
            }, ms),
            resolve
          }
          delaysRef.current.add(delay)
        })
      const fail = (): false => {
        if (generationRef.current === generation) {
          onSendError('Answer not sent')
        }
        return false
      }
      const lines = text.split('\n')
      // Only Claude renders one question per step and advances on each Enter, so
      // a multi-line answer is paced per question; non-Claude submits in one Enter.
      if (!shouldStepNativeChatAskAnswer(agentRef.current) || lines.length <= 1) {
        return (await sendTerminal(text, true)) || fail()
      }
      for (let index = 0; index < lines.length; index += 1) {
        if (generationRef.current !== generation || !(await sendTerminal(lines[index]!, false))) {
          return fail()
        }
        if (!(await wait(MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS))) {
          return false
        }
        if (!(await sendTerminal('', true))) {
          return fail()
        }
        if (index < lines.length - 1 && !(await wait(MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS))) {
          return false
        }
      }
      return true
    },
    [
      agentRef,
      enabled,
      cancelPending,
      client,
      deviceTokenRef,
      handleRef,
      onSendError,
      sessionId,
      streamIdentity
    ]
  )

  return { answerAsk, cancelPending }
}
