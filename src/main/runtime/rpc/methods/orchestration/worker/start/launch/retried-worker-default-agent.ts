import { z } from 'zod'
import { ResolvedProjectDefaultAgentSelection } from '../../../../../../../../shared/rpc-contract/project-default-agent-params'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker-start-input'

const PriorAgent = z.object({
  agent: z.string().refine(isTuiAgent),
  agentSelection: ResolvedProjectDefaultAgentSelection.optional()
})

export function retriedWorkerDefaultAgent(db: OrchestrationDb, params: WorkerStartInput) {
  if (params.agent !== 'default' || !params.retryOf) {
    return undefined
  }
  const prior = db.getWorkerDispatch(params.retryOf)
  let options: unknown
  try {
    options = prior && JSON.parse(prior.start_options)
  } catch {
    // The persisted attempt is not a usable source of an agent choice.
  }
  return parseRetriedWorkerDefaultAgent(options, params.retryOf)
}

export function parseRetriedWorkerDefaultAgent(options: unknown, dispatchId: string) {
  const parsed = PriorAgent.safeParse(options)
  if (!parsed.success || !isTuiAgent(parsed.data.agent)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Dispatch ${dispatchId} has no recorded agent to retry. Choose an explicit --agent. No effects were applied.`
    )
  }
  const agent = parsed.data.agent
  const selection =
    parsed.data.agentSelection?.agent === agent
      ? parsed.data.agentSelection
      : { agent, source: 'explicit' as const }
  return { agent, selection }
}
