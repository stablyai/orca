import { useMemo } from 'react'
import type { AgentSessionBackgroundTask } from '../../../../../src/shared/agent-session/agent-session-background-task-wire'
import { decodeAgentChildWorkViews } from '../../../../../src/shared/agent-status/child-work/agent-status-child-work-view-wire'
import { isAgentStatusFresh } from '../../../../../src/shared/agent-status/contracts/agent-status-freshness'
import { decodeAgentSubagentsField } from '../../../../../src/shared/agent-status/contracts/agent-status-subagent-snapshot'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import {
  agentChildRowContextForParent,
  type AgentChildRowContext,
  type AgentChildRowModel
} from '../../../../../src/shared/agent-status/presentation/agent-child-row-model'
import { agentChildRowContextForSessionStream } from '../../../../../src/shared/agent-status/presentation/agent-child-row-stream-context'
import { buildRunningAgentChildRowModels } from '../../../../../src/shared/running-agent-child-rows'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'

/** A terminal chat's strip input: the rows its hook row decides, and no Stop to offer. */
export type MobileTerminalChatSubagents = Omit<MobileStructuredBackgroundTasks, 'stop'> & {
  rows: readonly AgentChildRowModel[]
}

type RunningSubagents = Pick<MobileTerminalChatSubagents, 'rows' | 'rowContext'>

const NO_TASKS: AgentSessionBackgroundTask[] = []
const NONE_RUNNING: RunningSubagents = {
  rows: [],
  rowContext: agentChildRowContextForSessionStream(true, 0)
}

/** Hook subagents report only their role, so the shared name rule would tail every row with its id. */
function withoutIdTail(row: AgentChildRowModel): AgentChildRowModel {
  const { idSuffix: _idTail, ...named } = row
  return { ...named, owned: row.owned.map(withoutIdTail) }
}

/** Read a terminal tab's hook row as the workspace list does, so the two cannot disagree. */
function runningSubagents(
  status: AgentStatusEntry,
  options: {
    /** A row retained off the socket does not prove its subagents still run. */
    connected: boolean
    parentEvidenceFresh: boolean
  }
): RunningSubagents {
  const parent = agentChildRowContextForParent(status, options.parentEvidenceFresh)
  const rowContext: AgentChildRowContext = options.connected
    ? parent
    : { ...parent, transportObservation: 'unverifiable' }
  return {
    rowContext,
    rows: buildRunningAgentChildRowModels(
      {
        children: decodeAgentChildWorkViews(status.children),
        subagents: decodeAgentSubagentsField(status.subagents)
      },
      rowContext
    ).map(withoutIdTail)
  }
}

export function useMobileTerminalChatSubagents(args: {
  sessionKey: string | null
  /** The terminal chat's hook row; null for structured chats or when no chat shows. */
  status: AgentStatusEntry | null | undefined
  connected: boolean
  turnActive: boolean
}): MobileTerminalChatSubagents | null {
  const { connected, sessionKey, status, turnActive } = args
  const parentEvidenceFresh = status != null && isAgentStatusFresh(status)
  const reported = useMemo(
    () => (status ? runningSubagents(status, { connected, parentEvidenceFresh }) : NONE_RUNNING),
    [status, connected, parentEvidenceFresh]
  )
  // Status pings arrive per streamed part; a chat with no subagents must hand the tray one value.
  const running = reported.rows.length > 0 ? reported : NONE_RUNNING
  const show = running.rows.length > 0
  const isMonitoring = show && !turnActive
  return useMemo(
    () =>
      sessionKey === null
        ? null
        : {
            sessionKey,
            view: {
              show,
              isMonitoring,
              tasks: NO_TASKS,
              settledTasks: NO_TASKS,
              supportsStop: false,
              offersStopAll: false,
              incomplete: false
            },
            rowContext: running.rowContext,
            rows: running.rows
          },
    [sessionKey, running, show, isMonitoring]
  )
}
