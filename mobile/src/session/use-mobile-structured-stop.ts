import { useCallback, useMemo, type MutableRefObject } from 'react'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState,
  AgentSessionCancelResult
} from '../../../src/shared/agent-session-wire'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-projection'
import {
  requestStructuredAgentSessionMutation,
  retainStructuredSessionOperationId as retainStructuredOpId
} from './mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc-client'

/** The host keys cancel by turn, but a background-task stop belongs to the
 *  session rather than to any one turn, so the scope carries a placeholder. */
const BACKGROUND_TASKS_TURN_ID = 'background-tasks'

type CancelFields = {
  turnId: string
  scope?: 'background-tasks'
  taskId?: string
}

export type MobileStructuredBackgroundTasks = {
  backgroundTasks: AgentSessionBackgroundTask[]
  /** False on hosts that report background state but cannot act on it, so the
   *  row stays read-only instead of offering a Stop that does nothing. */
  supportsBackgroundTaskStop: boolean
  /** Only once the turn is over: mid-turn the composer already shows Stop. */
  isMonitoringBackgroundTasks: boolean
  /** Stops one background task, or every one when no id is given. */
  stopBackgroundTask: (taskId?: string) => void
}

export type MobileStructuredStop = MobileStructuredBackgroundTasks & {
  /** Interrupts the running turn. */
  cancel: () => void
}

/** The legacy PTY lane has no background-task lifecycle at all. */
export const NO_BACKGROUND_TASKS: MobileStructuredBackgroundTasks = {
  backgroundTasks: [],
  supportsBackgroundTaskStop: false,
  isMonitoringBackgroundTasks: false,
  stopBackgroundTask: () => {}
}

export function useMobileStructuredStop(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  sessionKey: string
  stateRef: MutableRefObject<{
    fence: number | null
    items: Parameters<typeof activeStructuredAgentSessionTurnId>[0]
    backgroundTasks?: AgentSessionBackgroundTaskState | null
  }>
  backgroundTaskState: AgentSessionBackgroundTaskState | null | undefined
  turnId: string | null
  operationIdsRef: MutableRefObject<Map<string, string>>
  onSendError: (message: string) => void
}): MobileStructuredStop {
  const {
    backgroundTaskState,
    client,
    enabled,
    onSendError,
    operationIdsRef,
    sessionId,
    sessionKey,
    stateRef,
    turnId
  } = args

  const send = useCallback(
    (fields: CancelFields, fence: number, onSettled: (message: string) => void): void => {
      const key = `${sessionKey}:agentSession.cancel:${JSON.stringify(fields)}`
      const clientOperationId = retainStructuredOpId(
        operationIdsRef.current,
        key,
        operationIdsRef.current.get(key)
      )
      void requestStructuredAgentSessionMutation<AgentSessionCancelResult>({
        client: client!,
        method: 'agentSession.cancel',
        fingerprintMethod: 'agentSession.cancel',
        sessionId: sessionId!,
        expectedRuntimeFence: fence,
        fields,
        clientOperationId
      }).then((result) => {
        if (result.status !== 'unknown') {
          operationIdsRef.current.delete(key)
        }
        if (result.status === 'unknown') {
          // An ack lost after the frame went out may still have stopped the
          // work; a definite failure would invite a pointless second stop.
          onSendError('Stop unconfirmed — check chat before retrying')
        } else if (result.status === 'refused') {
          onSendError(result.message)
        } else if (result.status === 'failed') {
          onSettled(result.message)
        }
      })
    },
    [client, onSendError, operationIdsRef, sessionId, sessionKey]
  )

  const cancel = useCallback(() => {
    const current = stateRef.current
    const activeTurnId = activeStructuredAgentSessionTurnId(current.items)
    if (!client || !sessionId || !enabled || current.fence === null || !activeTurnId) {
      onSendError('Stop not sent')
      return
    }
    send({ turnId: activeTurnId }, current.fence, (message) =>
      onSendError(message === 'Request not sent' ? 'Stop not sent' : message)
    )
  }, [client, enabled, onSendError, send, sessionId, stateRef])

  const stopBackgroundTask = useCallback(
    (taskId?: string) => {
      const fence = stateRef.current.fence
      if (!client || !sessionId || !enabled || fence === null) {
        onSendError('Background terminals not stopped')
        return
      }
      send(
        {
          turnId: BACKGROUND_TASKS_TURN_ID,
          scope: 'background-tasks',
          ...(taskId ? { taskId } : {})
        },
        fence,
        (message) =>
          onSendError(message === 'Request not sent' ? 'Background terminals not stopped' : message)
      )
    },
    [client, enabled, onSendError, send, sessionId, stateRef]
  )

  const tasks = backgroundTaskState?.tasks
  const backgroundTasks = useMemo(() => tasks ?? [], [tasks])

  return {
    cancel,
    backgroundTasks,
    supportsBackgroundTaskStop: backgroundTaskState?.supportsTaskStop === true,
    isMonitoringBackgroundTasks: turnId === null && backgroundTaskState?.state === 'monitoring',
    stopBackgroundTask
  }
}
