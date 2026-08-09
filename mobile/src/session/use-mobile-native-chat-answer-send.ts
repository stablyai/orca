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
import {
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome
} from './mobile-native-chat-send'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'
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
  // Per-terminal count of this hook's chains sharing one write-lock hold: a
  // superseding answer inherits the cancelled chain's hold (it re-enters before
  // the old chain unwinds), and only the last chain out releases the lock.
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
      // One composed write sequence per terminal: an answer landing mid-flight
      // in an image paste (or vice versa) would interleave bytes into the PTY.
      // A superseding answer shares the cancelled chain's hold on this terminal
      // (that chain has not unwound to its release yet).
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
      // A new answer supersedes any still-pending keystroke writes.
      cancelPending()
      const generation = generationRef.current
      let sawUnknownOutcome = false
      let sawAcceptedGroup = false
      let predecessorSafe = true
      try {
        predecessorSafe = await previousTurn
        if (!predecessorSafe) {
          // Fenced. Report it: the card re-enables on a false result, so silence
          // here is indistinguishable from a dead button. "Check chat" rather than
          // a bare "not sent" because the PREVIOUS answer's keys may have landed.
          // Gate on the turn slot, not the generation: a dropped input lease bumps
          // the generation without writing the Escape that Stop and ask-cancel do,
          // so the card is still up and silence there strands an advanced selector.
          if (writeTurnsRef.current.get(handle) === turn) {
            onSendError('Answer not sent — check chat before retrying')
          }
          return false
        }
        // Superseded by a newer answer, which owns the error surface from here.
        if (generationRef.current !== generation) {
          return false
        }
        // One budget for the whole answer instead of a fresh timeout per keystroke
        // group, which let an N-group selector hold the card for N × the send timeout.
        // It bounds transport time only: each deliberate pacing wait is credited back
        // below, so a long multi-question answer still gets a full budget to write in.
        let deadline = openMobileNativeChatSendBudget()
        const sendTerminal = async (body: string, enter: boolean): Promise<boolean> => {
          const activeRoute = activeRouteRef.current
          if (
            !activeRoute.enabled ||
            activeRoute.client !== client ||
            activeRoute.sessionId !== sessionId ||
            activeRoute.streamIdentity !== streamIdentity ||
            handleRef.current !== handle
          ) {
            return false
          }
          const outcome = await sendMobileNativeChatMessageWithOutcome({
            client,
            terminal: handle,
            text: body,
            enter,
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
          // Already superseded: don't hold the successor for a full pacing step
          // waiting on a timer whose only job is to report the cancellation.
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
            // Why: keystrokes that may have landed (ack lost / path cutover) must
            // not read as a definite failure — a blind resend could double-step
            // the selector. An earlier group that WAS accepted is the same hazard
            // in definite form: a multi-question answer whose shared budget ran out
            // mid-sequence left the remote selector half-stepped, and telling the
            // user nothing was sent invites a retry on top of the advanced state.
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
        // Grok commits pasted labels; Claude and Codex need their selector-specific
        // keystrokes paced so each step renders before the next lands.
        if (!shouldStepNativeChatAskAnswer(agentRef.current)) {
          // This shape pastes the label into the composer and commits it, so an
          // orphaned image paste would be submitted along with the answer (#10228).
          // The selector shapes below deliberately skip the heal: their keys are
          // `enter: false` for an active overlay, and a single-select answer is a
          // bare option digit that cannot submit the line at all, so clearing there
          // would consume the marker still protecting the next real message.
          // Desktop splits it identically — use-native-chat-interactive-send.ts
          // routes only the pasted-label shape through the clearing sender.
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
          // A chain a successor took over from must not report success either: an
          // accepted answer retires the shared send-error banner, wiping the
          // successor's fence. Test the turn slot, not the generation counter —
          // Stop, ask-cancel and a dropped lease all bump the generation with no
          // successor, and there a landed answer IS a success.
          const sent = (await sendTerminal(formatAskAnswer(prompt, selections), true)) || fail()
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
          const body = 'raw' in group ? group.raw : sanitizeAskFreeText(group.text)
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
        // Taken over on the last key: same as above, the successor owns the surface.
        return groups.length > 0 && writeTurnsRef.current.get(handle) === turn
      } finally {
        // Any accepted key changed the live selector, so a queued replacement
        // cannot safely apply its from-scratch key plan to that new position.
        finishTurn(predecessorSafe && !sawUnknownOutcome && !sawAcceptedGroup)
        if (writeTurnsRef.current.get(handle) === turn) {
          writeTurnsRef.current.delete(handle)
        }
        // Last chain out releases; a superseded chain unwinding late must not
        // free the lock out from under the successor sharing its hold.
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
