import { agentSessionWriteNoticeParts } from '../../../src/shared/agent-session/failures/agent-session-refusal-notice'
import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'
import { useCallback, useMemo } from 'react'
import type { AgentChildRowContext } from '../../../src/shared/agent-status/presentation/agent-child-row-model'
import type { AgentSessionCancelResult } from '../../../src/shared/agent-session/agent-session-wire'
import { agentChildRowContextForSessionStream } from '../../../src/shared/agent-status/presentation/agent-child-row-stream-context'
import type { StructuredAgentSessionState } from '../../../src/shared/agent-session/structured-agent-session-reducer'
import {
  structuredSessionBackgroundTasksView,
  type StructuredSessionBackgroundTasksView
} from '../../../src/shared/structured-session-background-tasks-view'
import { structuredSessionForegroundCommands } from '../../../src/shared/structured-session-foreground-commands'
import type { StructuredAgentSessionMutationResult } from './mobile-structured-agent-session-rpc'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { mobileStructuredHostClockOffsetMs } from './mobile-structured-host-clock-offset'
import type {
  AgentSessionForegroundTask,
  AgentSessionBackgroundResult
} from '../../../src/shared/agent-session/agent-session-foreground-task'

export type MobileStructuredBackgroundTasks = {
  // Scope strip expansion and stopping state to the conversation.
  sessionKey: string
  view: StructuredSessionBackgroundTasksView
  // Treat retained rows as unverifiable off-stream; convert host timestamps with this offset.
  rowContext: AgentChildRowContext
  stop: (taskId?: string) => Promise<StructuredAgentSessionMutationResult<AgentSessionCancelResult>>
  background?: (task: AgentSessionForegroundTask) => Promise<boolean>
}

export function useMobileStructuredBackgroundTasks(args: {
  sessionKey: string
  state: StructuredAgentSessionState
  turnId: string | null
  // Retained roster does not prove current liveness.
  connected: boolean
  mutate: MobileStructuredAgentMutate
  onSendError: (message: string) => void
}): MobileStructuredBackgroundTasks {
  const { connected, mutate, onSendError, sessionKey, state, turnId } = args
  const { backgroundTasks, items, latestTurn } = state
  const view = useMemo(
    () =>
      structuredSessionBackgroundTasksView(
        backgroundTasks,
        turnId,
        structuredSessionForegroundCommands(backgroundTasks, { items, latestTurn })
      ),
    [backgroundTasks, items, latestTurn, turnId]
  )
  // Keep the roster through stream failure without claiming its tasks still run.
  const streamLive = connected && state.status === 'ready'
  const offsetMs = mobileStructuredHostClockOffsetMs(state.hostClock)
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
  const background = useCallback(
    async (target: AgentSessionForegroundTask) => {
      if (!streamLive) {
        return false
      }
      const result = await mutate<AgentSessionBackgroundResult>(
        'agentSession.backgroundTask',
        'agentSession.backgroundTask',
        { target }
      )
      if (result.status === 'unknown') {
        onSendError(
          mobileAgentSessionWriteNoticeText(
            agentSessionWriteNoticeParts({ kind: 'unconfirmed' }, 'background-task')
          )
        )
      }
      return result.status === 'accepted' && result.value.backgrounded && result.sameFence
    },
    [mutate, onSendError, streamLive]
  )
  return useMemo(
    () => ({ sessionKey, view, rowContext, stop, background }),
    [sessionKey, view, rowContext, stop, background]
  )
}
