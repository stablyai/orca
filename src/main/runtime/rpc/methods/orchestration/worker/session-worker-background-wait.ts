import { agentBackgroundWait } from '../../../../../../shared/agent-status/lifecycle/agent-background-wait'
import { structuredAgentSessionStatusPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'

/** An open worker whose turn ended while its own background tasks run, by its fleet row or its chat's. */
export function sessionWorkerBackgroundWait(
  worker: Pick<OrchestrationFleetWorker, 'stage'>,
  state: OrchestrationSessionWorker['state'],
  chatSessionId: string | null,
  chatStatusRows: ReadonlyMap<string, AgentStatusIpcPayload>
): Pick<OrchestrationSessionWorker, 'backgroundWait'> {
  if (state !== 'working') {
    return {}
  }
  const chatRow = chatSessionId
    ? chatStatusRows.get(structuredAgentSessionStatusPaneKey(chatSessionId))
    : undefined
  const wait = worker.stage.backgroundWait ?? (chatRow ? agentBackgroundWait(chatRow) : null)
  return wait ? { backgroundWait: wait } : {}
}
