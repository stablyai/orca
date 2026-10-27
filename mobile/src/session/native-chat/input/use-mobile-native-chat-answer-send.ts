import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer
} from '../../../../../src/shared/native-chat-ask-answer'
import type { AskAnswerSelection } from '../../../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../src/shared/native-chat-ask-types'
import type { RpcClient } from '../../../transport/rpc-client'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import {
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome
} from '../mobile-native-chat-send'
import { healMobileNativeChatStaleInput } from '../mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from '../mobile-native-chat-terminal-write-lock'
import {
  nativeChatAskRequiresTerminal,
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from '../../../../../src/shared/native-chat-agent-support'
import { buildNativeChatPasteBytes } from '../../../../../src/shared/native-chat-paste-bytes'

export type MobileNativeChatAnswerSend = {
  answerAsk: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  /** Cancel unsent groups; an already-issued write may still settle. */
  cancelPending: () => void
}

// Pace existing terminal.send key groups for legacy selectors; cancellation stops future groups but preserves already-issued writes’ delivery verdicts.
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
  // Superseding chains share a terminal hold; only the last chain out may release it.
  const writeHoldsRef = useRef(new Map<string, number>())
  // Successors wait for the prior RPC and inherit any delivery ambiguity.
  const writeTurnsRef = useRef(new Map<string, Promise<boolean>>())
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

  useEffect(() => {
    if (!enabled) {
      cancelPending()
    }
    return cancelPending
  }, [client, enabled, sessionId, streamIdentity, cancelPending])

  const answerAsk = useCallback(
    async (prompt: AskPrompt, selections: AskAnswerSelection[]): Promise<boolean> => {
      if (nativeChatAskRequiresTerminal(agentRef.current)) {
        cancelPending()
        onSendError('Answer this question in terminal view')
        return false
      }
      const handle = handleRef.current
      if (!client || !handle || !enabled) {
        onSendError('Answer not sent (disconnected)')
        return false
      }
      if (!hasAskAnswer(prompt, selections)) {
        return false
      }
      // Serialize answers with image sequences to prevent PTY byte interleaving; successors inherit the prior answer’s hold.
      const holds = writeHoldsRef.current
      const heldCount = holds.get(handle) ?? 0
      if (heldCount === 0 && !acquireMobileNativeChatTerminalWrite(handle)) {
        onSendError('Answer not sent')
        return false
      }
      holds.set(handle, heldCount + 1)
      const previousTurn = writeTurnsRef.current.get(handle) ?? Promise.resolve(true)
      let finishTurn: (safeToContinue: boolean) => void = () => undefined
      const turn = new Promise<boolean>((resolve) => {
        finishTurn = resolve
      })
      writeTurnsRef.current.set(handle, turn)
      cancelPending()
      const generation = generationRef.current
      let sawUnknownOutcome = false
      let sawAcceptedGroup = false
      let predecessorSafe = true
      try {
        predecessorSafe = await previousTurn
        if (!predecessorSafe) {
          // Report fences on the live turn slot: lease loss bumps generation without Escape, and silence would invite retry on an advanced selector.
          if (writeTurnsRef.current.get(handle) === turn) {
            onSendError('Answer not sent — check chat before retrying')
          }
          return false
        }
        if (generationRef.current !== generation) {
          return false
        }
        // Budget transport once per answer; credit deliberate pacing so multi-question selectors retain the full write budget.
        let deadline = openMobileNativeChatSendBudget()
        const sendTerminal = async (body: string, enter: boolean): Promise<boolean> => {
          const activeRoute = activeRouteRef.current
          if (
            !activeRoute.enabled ||
            activeRoute.client !== client ||
            activeRoute.sessionId !== sessionId ||
            activeRoute.streamIdentity !== streamIdentity ||
            handleRef.current !== handle ||
            nativeChatAskRequiresTerminal(agentRef.current)
          ) {
            return false
          }
          const outcome = await sendMobileNativeChatMessageWithOutcome({
            client,
            terminal: handle,
            text: body,
            enter,
            requireWriteSettlement: true,
            deadline,
            ...(deviceTokenRef.current
              ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
              : {})
          })
          if (outcome === 'unknown') {
            sawUnknownOutcome = true
          }
          if (outcome === 'accepted') {
            sawAcceptedGroup = true
          }
          return outcome === 'accepted'
        }
        const wait = (ms: number): Promise<boolean> => {
          // Already-superseded chains must not delay successors on a cancellation-only timer.
          if (generationRef.current !== generation) {
            return Promise.resolve(false)
          }
          return new Promise((resolve) => {
            const delay = {
              timer: setTimeout(() => {
                delaysRef.current.delete(delay)
                resolve(generationRef.current === generation)
              }, ms),
              resolve
            }
            delaysRef.current.add(delay)
          })
        }
        const fail = (): false => {
          if (generationRef.current === generation) {
            // Accepted or uncertain earlier keys may have advanced the selector; never invite blind replay as a definite non-send.
            onSendError(
              sawAcceptedGroup
                ? 'Answer partly sent — check chat before retrying'
                : sawUnknownOutcome
                  ? 'Answer unconfirmed — check chat before retrying'
                  : 'Answer not sent'
            )
          }
          return false
        }
        // Pace Claude/Codex selector keys; other agents and async questions accept pasted answers.
        if (prompt.replyAsMessage || !shouldStepNativeChatAskAnswer(agentRef.current)) {
          // Heal only pasted answers: selector overlays swallow clear keys and would consume the stale marker still protecting the next message.
          if (
            !(await healMobileNativeChatStaleInput({
              client,
              terminal: handle,
              deviceToken: deviceTokenRef.current,
              deadline
            }))
          ) {
            if (generationRef.current === generation) {
              onSendError('Answer not sent')
            }
            return false
          }
          if (generationRef.current !== generation) {
            return false
          }
          // Only the owning turn may report success and clear errors; generation changes without successors still allow landed-answer success.
          const sent =
            (await sendTerminal(
              buildNativeChatPasteBytes(formatAskAnswer(prompt, selections)),
              true
            )) || fail()
          return sent && writeTurnsRef.current.get(handle) === turn
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
          const body = 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text)
          if (!(await sendTerminal(body, false))) {
            return fail()
          }
          if (index < groups.length - 1) {
            if (!(await wait(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))) {
              return false
            }
            // Pacing is deliberate, not transport latency — don't charge it to the budget.
            deadline += MOBILE_NATIVE_CHAT_QUESTION_STEP_MS
          }
        }
        return groups.length > 0 && writeTurnsRef.current.get(handle) === turn
      } finally {
        // Any accepted/uncertain key may advance the selector, making a successor’s from-scratch plan unsafe.
        finishTurn(predecessorSafe && !sawUnknownOutcome && !sawAcceptedGroup)
        if (writeTurnsRef.current.get(handle) === turn) {
          writeTurnsRef.current.delete(handle)
        }
        // Release only after the last sharing chain unwinds so an old completion cannot free its successor’s lock.
        const remaining = (holds.get(handle) ?? 1) - 1
        if (remaining <= 0) {
          holds.delete(handle)
          releaseMobileNativeChatTerminalWrite(handle)
        } else {
          holds.set(handle, remaining)
        }
      }
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
