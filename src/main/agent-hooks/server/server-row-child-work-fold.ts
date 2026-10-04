import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../../shared/agent-lead-status-fold'
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentStatusState, AgentSubagentSnapshot } from '../../../shared/agent-status-types'

type RowChildWork = Pick<AgentHookEventPayload, 'claudeRunningNonAgentTask'> & {
  payload: { subagents?: readonly AgentSubagentSnapshot[] }
}

/** Fold a main agent state with the child work a row itself carries: its subagent snapshots and the
 *  shell/cron fact restated beside them. For a relayed pane that is all the desktop can see, because
 *  the provider records live on the relay. */
export function foldMainAgentWithRowChildWork(
  leadState: AgentStatusState,
  row: RowChildWork
): AgentLeadStatusResolution {
  const childWorkLiveness = agentChildWorkLiveness([
    ...(row.payload.subagents?.map((child) => ({ kind: 'agent' as const, state: child.state })) ??
      []),
    ...(row.claudeRunningNonAgentTask
      ? [{ kind: 'command' as const, state: 'working' as const }]
      : [])
  ])
  return foldAgentLeadStatus({ leadState, childWorkLiveness })
}
