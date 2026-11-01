import { useMemo } from 'react'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import { isStructuredAgentSessionThinking } from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat/transcript/native-chat-turn-activity'
import { agentStopDisplayStatus } from '../../../src/shared/agent-stop-display-status'
import { mobileStructuredSendQueues } from './use-mobile-structured-send-with-outcome'
import {
  nativeChatSendFollowUp,
  type NativeChatSendFollowUp
} from '../../../src/shared/native-chat-follow-up-behavior'

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
  sendFollowUp?: NativeChatSendFollowUp
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
  const isWorking = input.isWorking || input.queueSendsNext
  const sendFollowUp =
    queueCapable && working && !stopping
      ? nativeChatSendFollowUp((alternate) =>
          mobileStructuredSendQueues(queueCapable, queueFollowUps, state, {
            alternate,
            isWorking,
            stopping
          })
        )
      : null
  const followUpAction = sendFollowUp?.action
  const followUpOffersChoice = sendFollowUp?.offersChoice === true
  return useMemo(
    () => ({
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      ...(followUpAction
        ? { sendFollowUp: { action: followUpAction, offersChoice: followUpOffersChoice } }
        : {}),
      ...(afterStop ? { afterStop } : {})
    }),
    [
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      followUpAction,
      followUpOffersChoice,
      afterStop
    ]
  )
}
