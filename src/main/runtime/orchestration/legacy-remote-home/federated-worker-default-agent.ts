import { z } from 'zod'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { orchestrationMigrationData } from '../../../../shared/orchestration/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../orchestration-error'
import type { WorkerStartInput } from '../../rpc/methods/orchestration/worker/start/worker-start-input'
import { assertWorkerLaunchPreferencesRuntimeSupported } from '../../rpc/methods/orchestration/worker/start/launch/worker-launch-preferences'
import type { OrchestrationDb } from '../db/orchestration-db'
import { retriedWorkerDefaultAgent } from '../../rpc/methods/orchestration/worker/start/launch/retried-worker-default-agent'
import { createPendingWorkerLaunchReceipt } from '../../rpc/methods/orchestration/worker/start/launch/worker-launch-preferences'

const DefaultAgentSelection = z.object({
  agent: z.string().refine(isTuiAgent).nullable(),
  source: z.enum(['project', 'global', 'automatic', 'explicit']),
  projectId: z.string().optional(),
  projectName: z.string().optional()
})

export function assertFederatedWorkerServerCapabilities(args: {
  capabilities?: readonly string[]
  serverName: string
  model?: string
  effort?: string
}): void {
  if (!args.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      `Connected server ${args.serverName} does not support the current orchestration contract. No effects were applied.`,
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  if (!args.capabilities?.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support orchestration federation.`
    )
  }
  assertWorkerLaunchPreferencesRuntimeSupported(args)
}

export async function resolveFederatedWorkerAgent(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: WorkerStartInput
  server: ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>
  worktree: string
  createsWorktree: boolean
  capabilities?: readonly string[]
  preflightTimeoutMs: number
}) {
  const { runtime, server, worktree } = args
  const retried = retriedWorkerDefaultAgent(args.db, args.params)
  const params = retried ? { ...args.params, agent: retried.agent } : args.params
  const retriedSelection = retried?.selection
  if (
    (params.agent === 'default' || retriedSelection) &&
    !args.capabilities?.includes(PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} cannot resolve project default agents. Update or restart it and try again. No effects were applied.`
    )
  }
  const defaultSelection =
    params.agent === 'default' || retriedSelection
      ? DefaultAgentSelection.parse(
          await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'agent.resolveDefault',
            args.createsWorktree
              ? { repo: params.repo, validateAgent: retriedSelection?.agent }
              : { worktree, validateAgent: retriedSelection?.agent },
            args.preflightTimeoutMs,
            undefined,
            { expectedEnvironmentPairingRevision: server.pairingRevision }
          )
        )
      : undefined
  if (retriedSelection && defaultSelection?.agent !== retriedSelection.agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Connected server ${server.name} could not validate the retried agent ${retriedSelection.agent}. No effects were applied.`
    )
  }
  if (defaultSelection && !defaultSelection.agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `The default agent for ${defaultSelection.projectName ?? params.repo ?? worktree} is Blank Terminal or unavailable. Choose an explicit --agent or update the project default. No effects were applied.`
    )
  }
  const agent = defaultSelection?.agent ?? params.agent
  const selection =
    retriedSelection ??
    (defaultSelection?.agent
      ? { ...defaultSelection, agent: defaultSelection.agent }
      : isTuiAgent(agent)
        ? { agent, source: 'explicit' as const }
        : undefined)
  return {
    resolvedAgent: agent,
    agentSelection: selection,
    requestedLaunch: createPendingWorkerLaunchReceipt({
      agent: isTuiAgent(agent) ? agent : null,
      model: params.model,
      effort: params.effort
    })
  }
}
