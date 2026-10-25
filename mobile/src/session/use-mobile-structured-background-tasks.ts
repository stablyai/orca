import { useCallback, useMemo } from 'react'
import type { AgentChildRowContext } from '../../../src/shared/agent-child-row-model'
import type { AgentSessionCancelResult } from '../../../src/shared/agent-session-wire'
import { agentChildRowContextForSessionStream } from '../../../src/shared/agent-child-row-stream-context'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  structuredSessionBackgroundTasksView,
  type StructuredSessionBackgroundTasksView
} from '../../../src/shared/structured-session-background-tasks-view'
import type { StructuredAgentSessionMutationResult } from './mobile-structured-agent-session-rpc'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

export type MobileStructuredBackgroundTasks = {
  // Scope strip expansion and stopping state to the conversation.
  sessionKey: string
  view: StructuredSessionBackgroundTasksView
  // Treat retained rows as unverifiable off-stream; convert host timestamps with this offset.
  rowContext: AgentChildRowContext
  stop: (taskId?: string) => Promise<StructuredAgentSessionMutationResult<AgentSessionCancelResult>>
}

// Ignore delivery jitter below the precision of displayed clocks.
const OFFSET_GRAIN_MS = 1_000

export function useMobileStructuredBackgroundTasks(args: {
  sessionKey: string
  state: StructuredAgentSessionState
  turnId: string | null
  // Retained roster does not prove current liveness.
  connected: boolean
  mutate: MobileStructuredAgentMutate
}): MobileStructuredBackgroundTasks {
  const { connected, mutate, sessionKey, state, turnId } = args
  const view = useMemo(
    () => structuredSessionBackgroundTasksView(state.backgroundTasks, turnId),
    [state.backgroundTasks, turnId]
  )
  // Keep the roster through stream failure without claiming its tasks still run.
  const streamLive = connected && state.status === 'ready'
  // Use each host sample for restarts/clock corrections; round away jitter to preserve row memoization.
  const hostClock = state.hostClock
  const offsetMs = hostClock
    ? Math.round((hostClock.receivedAt - hostClock.hostNow) / OFFSET_GRAIN_MS) * OFFSET_GRAIN_MS
    : 0
  const rowContext = useMemo(
    () => agentChildRowContextForSessionStream(streamLive, offsetMs),
    [streamLive, offsetMs]
  )
  const stop = useCallback(
    (taskId?: string) =>
      mutate<AgentSessionCancelResult>('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
      }),
    [mutate]
  )
  return useMemo(
    () => ({ sessionKey, view, rowContext, stop }),
    [sessionKey, view, rowContext, stop]
  )
}
