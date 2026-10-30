import { useMemo } from 'react'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import { isStructuredAgentSessionThinking } from '../../../src/shared/structured-agent-session-live-turn'
import { selectStructuredAgentTurnActivity } from '../../../src/shared/native-chat/transcript/native-chat-turn-activity'
import { agentStopDisplayStatus } from '../../../src/shared/agent-stop-display-status'
import { mobileStructuredSendQueues } from './use-mobile-structured-send-with-outcome'

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
}): NativeChatLiveTurnIndicator & { stopping: boolean } {
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
  return useMemo(
    () => ({
      thinking,
      activityText,
      stopping,
      stopRequestInFlight,
      ...(afterStop ? { afterStop } : {})
    }),
    [thinking, activityText, stopping, stopRequestInFlight, afterStop]
  )
}
