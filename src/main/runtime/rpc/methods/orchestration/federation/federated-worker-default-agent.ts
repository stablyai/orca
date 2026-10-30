import { z } from 'zod'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-launch-runtime-capability'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { orchestrationMigrationData } from '../../../../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import { assertWorkerLaunchPreferencesRuntimeSupported } from '../worker/worker-launch-preferences'
import type { WorkerDefaultAgentSelection } from '../worker/worker-configured-agent-preflight'

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
  params: WorkerStartInput
  server: ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>
  worktree: string
  createsWorktree: boolean
  capabilities?: readonly string[]
  preflightTimeoutMs: number
  retriedSelection?: WorkerDefaultAgentSelection
}) {
  const { runtime, params, server, worktree } = args
  if (
    (params.agent === 'default' || args.retriedSelection) &&
    !args.capabilities?.includes(PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} cannot resolve project default agents. Update or restart it and try again. No effects were applied.`
    )
  }
  const defaultSelection =
    params.agent === 'default' || args.retriedSelection
      ? DefaultAgentSelection.parse(
          await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'agent.resolveDefault',
            args.createsWorktree
              ? { repo: params.repo, validateAgent: args.retriedSelection?.agent }
              : { worktree, validateAgent: args.retriedSelection?.agent },
            args.preflightTimeoutMs,
            undefined,
            { expectedEnvironmentPairingRevision: server.pairingRevision }
          )
        )
      : undefined
  if (args.retriedSelection && defaultSelection?.agent !== args.retriedSelection.agent) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Connected server ${server.name} could not validate the retried agent ${args.retriedSelection.agent}. No effects were applied.`
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
    args.retriedSelection ??
    (defaultSelection?.agent
      ? { ...defaultSelection, agent: defaultSelection.agent }
      : isTuiAgent(agent)
        ? { agent, source: 'explicit' as const }
        : undefined)
  return { agent, selection }
}
