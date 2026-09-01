import type { AgentLaunchSpawnRequest } from '../../../../shared/agent-launch-spawn-request'
import { isCustomTuiAgentId } from '../../../../shared/custom-tui-agent-identity'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** The legacy `startupAgent` path is built-in-only; a custom id must resolve
 *  through the host agentLaunch boundary to reach its base harness. */
export function workerCustomAgentLaunchRequest(agent: TuiAgent): AgentLaunchSpawnRequest | null {
  return isCustomTuiAgentId(agent)
    ? { selection: { kind: 'agent', agent }, allowEmptyPromptLaunch: true }
    : null
}

export function describeWorkerAgentLaunchRejection(outcome: {
  status: 'failed' | 'rejected'
  failure?: { code: string }
  requestError?: { code: string }
}): string {
  return outcome.status === 'failed'
    ? (outcome.failure?.code ?? 'launch_failed')
    : (outcome.requestError?.code ?? 'launch_rejected')
}
