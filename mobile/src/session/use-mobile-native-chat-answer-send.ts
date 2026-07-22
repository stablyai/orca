import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  type AskAnswerSelection,
  type AskPrompt
} from './mobile-native-chat-ask'
import { sendMobileNativeChatMessage } from './mobile-native-chat-send'
import {
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from '../../../src/shared/native-chat-agent-support'

/** Sends an ask-user answer to the active chat pane. Claude and Codex selectors
 *  use their agent-specific keystrokes; other agents get pasted label text.
 *  Extracted from the session route to keep that file under its line cap and to
 *  own the pending-timer lifecycle in one place. */
export type MobileNativeChatAnswerSend = {
  /** Answer the current question(s) from the card's per-question selections. */
  answerAsk: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  /** Drop any in-flight per-keystroke writes (call on Stop). */
  cancelPending: () => void
}

// A free-text answer is written as raw keystrokes into Claude's "Type something"
// input (terminal.send has no paste framing), so an embedded newline would
// submit it early — collapse line breaks to spaces.
function sanitizeAskFreeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

/**
 * Owns the ask-answer send sequence for the mobile native chat. Reads the live
 * pane/agent through refs (the route already keeps them current) so the returned
 * callbacks stay stable. Selector answers are delivered as keystroke groups
 * written one step apart over the EXISTING
 * `terminal.send` passthrough (raw text, no enter) — same contract the
 * permission card already uses, so old runtimes replay them verbatim (no new
 * RPC; keystrokes are built client-side). The scheduled wait chain is cancelled
 * on a new answer, on `cancelPending` (Stop), and on unmount / session swap — so
 * a detached chain can never write PTY bytes to a stale pane.
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
    async (prompt: AskPrompt, selections: AskAnswerSelection[]): Promise<boolean> => {
      const handle = handleRef.current
      if (!client || !handle || !enabled) {
        onSendError('Answer not sent (disconnected)')
        return false
      }
      if (!hasAskAnswer(prompt, selections)) {
        return false
      }
      // A new answer supersedes any still-pending keystroke writes.
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
      // Grok commits pasted labels; Claude and Codex need their selector-specific
      // keystrokes paced so each step renders before the next lands.
      if (!shouldStepNativeChatAskAnswer(agentRef.current)) {
        return (await sendTerminal(formatAskAnswer(prompt, selections), true)) || fail()
      }
      const groups =
        resolveNativeChatTranscriptAgent(agentRef.current) === 'codex'
          ? buildCodexAskAnswerKeys(prompt, selections)
          : buildAskAnswerKeys(prompt, selections)
      for (let index = 0; index < groups.length; index += 1) {
        if (generationRef.current !== generation) {
          return false
        }
        const group = groups[index]!
        const body = 'raw' in group ? group.raw : sanitizeAskFreeText(group.text)
        if (!(await sendTerminal(body, false))) {
          return fail()
        }
        if (index < groups.length - 1 && !(await wait(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))) {
          return false
        }
      }
      return groups.length > 0
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
