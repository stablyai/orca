import { z } from 'zod'
import { ResolvedProjectDefaultAgentSelection } from '../../../../../shared/rpc-contract/project-default-agent-params'
import type { RemotePlacementRow } from '../../db/remote-owned/remote-placement-hold'
import type { WorkerDefaultAgentSelection } from '../../../rpc/methods/orchestration/worker/start/launch/worker-configured-agent-preflight'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { WorkerStartInput } from '../../../rpc/methods/orchestration/worker/start/worker-start-input'
import { parseRetriedWorkerDefaultAgent } from '../../../rpc/methods/orchestration/worker/start/launch/retried-worker-default-agent'
import { resolveFederatedWorkerAgent } from '../../legacy-remote-home/federated-worker-default-agent'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'
import { getRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationWorkerServer } from '../environment-transport'
import { callRemoteOwnedServer } from './remote-owned-calls'

const Status = z.object({ capabilities: z.array(z.string()).optional() })
const PriorWorker = z.object({ worker: z.object({ startOptions: z.unknown() }) })

export async function resolveRemoteOwnedDefaultAgent(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput,
  server: OrchestrationWorkerServer,
  timeoutMs: number,
  frozenSelection?: WorkerDefaultAgentSelection
) {
  if (params.agent !== 'default') {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  let retried = frozenSelection
    ? { agent: frozenSelection.agent, selection: frozenSelection }
    : undefined
  if (params.retryOf && !retried) {
    const prior = getRemoteDispatch(db, params.retryOf)
    const link = prior && getRemoteRunLink(db, prior.conversation_id)
    if (!link || link.environment_id !== server.environmentId) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Dispatch ${params.retryOf} has no recorded agent on ${server.name}. Choose an explicit --agent. No effects were applied.`
      )
    }
    const shown = PriorWorker.parse(
      await callRemoteOwnedServer(runtime, link, {
        method: 'orchestration.workerShow',
        params: { dispatch: params.retryOf },
        timeoutMs,
        whileLink: ['open']
      })
    )
    retried = parseRetriedWorkerDefaultAgent(shown.worker.startOptions, params.retryOf)
  }
  const status = Status.parse(
    await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'status.get',
      undefined,
      timeoutMs,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
  )
  const worktree = params.worktree ?? 'current'
  return resolveFederatedWorkerAgent({
    runtime,
    db,
    params,
    server,
    worktree,
    createsWorktree: worktree === 'new-top-level' || worktree === 'new-child',
    capabilities: status.capabilities,
    preflightTimeoutMs: timeoutMs,
    retried
  })
}

export function readRemotePlacementAgentSelection(
  placement: Pick<RemotePlacementRow, 'agent_selection'>
) {
  let value: unknown
  try {
    value = placement.agent_selection && JSON.parse(placement.agent_selection)
  } catch {
    value = undefined
  }
  const parsed = ResolvedProjectDefaultAgentSelection.safeParse(value)
  if (!parsed.success) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'The earlier remote start has no recorded default agent. Inspect its request receipt before retrying. No effects were applied.'
    )
  }
  return parsed.data
}
