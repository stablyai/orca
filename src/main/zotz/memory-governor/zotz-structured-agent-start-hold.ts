import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { StructuredAgentSessionResumeOutcome } from '../../native-chat/agent-session-wire/startup/structured-agent-session-agent-start'
import { failedStructuredAgentSessionStart } from '../../native-chat/agent-session-wire/startup/structured-agent-session-start-attempts'
import { getZotzAgentLaunchQueue } from './zotz-agent-launch-hold'
import { ZotzAgentLaunchCanceledError } from './zotz-agent-launch-queue'

/**
 * A native chat's provider process waits in the memory queue like a terminal agent
 * (docs/zotz/PLAN.md §8c). Null lets the start go on; a canceled wait ends it as aborted.
 */
export async function holdZotzStructuredAgentStart(
  record: AgentSessionRecord | null,
  wait: <T>(work: Promise<T>) => Promise<T>,
  signal: AbortSignal
): Promise<StructuredAgentSessionResumeOutcome | null> {
  const queue = getZotzAgentLaunchQueue()
  const agent = record?.provider
  if (!queue || !record || !isTuiAgent(agent)) {
    return null
  }
  const tabId = structuredAgentSessionTabId(record.sessionId)
  try {
    await wait(
      queue.admit({
        agent,
        priority: 'manual',
        paneKey: structuredAgentSessionPaneKey(tabId, record.sessionId),
        label: record.location.workspaceId,
        signal
      })
    )
    return null
  } catch (error) {
    if (error instanceof ZotzAgentLaunchCanceledError || signal.aborted) {
      return { ...failedStructuredAgentSessionStart(), aborted: true }
    }
    throw error
  }
}
