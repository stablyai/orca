import { useMemo } from 'react'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import { isStructuredAgentSessionThinking } from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat/transcript/native-chat-turn-activity'
import { agentStopDisplayStatus } from '../../../src/shared/agent-stop-display-status'
import { mobileStructuredSendQueues } from './use-mobile-structured-send-with-outcome'
import type { MobileNativeChatSendFollowUp } from './native-chat/mobile-native-chat-send'

export function useMobileStructuredTurnIndicator(input: {
  state: StructuredAgentSessionState
  turnId: string | null
  isWorking: boolean
  /** Desktop holds Stop on whether it can stop, which covers a send still in flight. */
  canStop: boolean
  hostStopping: boolean
  stopPressed: boolean
  queueCapable: boolean
  queueFollowUps: boolean
  /** The send's own working test counts a queued card about to send. */
  queueSendsNext: boolean
}): NativeChatLiveTurnIndicator & {
  stopping: boolean
  sendFollowUp?: MobileNativeChatSendFollowUp
} {
  const { state, turnId, hostStopping, stopPressed, queueCapable, queueFollowUps } = input
  const activityText = useMemo(
    () => selectStructuredAgentTurnActivity(state.items, turnId, state.activity)?.text ?? null,
    [state.items, turnId, state.activity]
  )
  const thinking = isStructuredAgentSessionThinking(state)
  const working = input.isWorking || input.canStop
  const stopping = agentStopDisplayStatus({ working, hostStopping, stopPressed }) === 'stopping'
  const stopRequestInFlight = working && stopPressed
  const afterStop = stopping
    ? mobileStructuredSendQueues(queueCapable, queueFollowUps, state)
      ? ('queue' as const)
      : ('send' as const)
    : undefined
  const midTurn = queueCapable && working && !stopping
  // The send's own resolver: a waiting command or unanswerable prompts can make both ways the same.
  const send = { isWorking: input.isWorking || input.queueSendsNext, stopping }
  const tapQueues = midTurn && mobileStructuredSendQueues(queueCapable, queueFollowUps, state, send)
  const alternateQueues =
    midTurn &&
    mobileStructuredSendQueues(queueCapable, queueFollowUps, state, { ...send, alternate: true })
  return useMemo(
    () => ({
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      ...(midTurn
        ? {
            sendFollowUp: {
              action: tapQueues ? ('queue' as const) : ('steer' as const),
              offersChoice: tapQueues !== alternateQueues
            }
          }
        : {}),
      ...(afterStop ? { afterStop } : {})
    }),
    [
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      midTurn,
      tapQueues,
      alternateQueues,
      afterStop
    ]
  )
}
