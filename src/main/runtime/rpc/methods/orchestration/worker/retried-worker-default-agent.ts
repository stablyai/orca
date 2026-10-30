import { z } from 'zod'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './worker-start-schema'

const PriorAgent = z.object({
  agent: z.string().refine(isTuiAgent),
  agentSelection: z
    .object({
      agent: z.string().refine(isTuiAgent),
      source: z.enum(['project', 'global', 'automatic', 'explicit']),
      projectId: z.string().optional(),
      projectName: z.string().optional()
    })
    .optional()
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
  const parsed = PriorAgent.safeParse(options)
  if (!parsed.success || !isTuiAgent(parsed.data.agent)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Dispatch ${params.retryOf} has no recorded agent to retry. Choose an explicit --agent. No effects were applied.`
    )
  }
  const agent = parsed.data.agent
  const selection =
    parsed.data.agentSelection?.agent === agent
      ? parsed.data.agentSelection
      : { agent, source: 'explicit' as const }
  return { agent, selection }
}
