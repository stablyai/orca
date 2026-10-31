import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { orchestrationMigrationData } from '../../../../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import {
  assertWorkerLaunchPreferencesRuntimeSupported,
  parseWorkerLaunchPreflight,
  type OrchestrationWorkerLaunchReceipt
} from '../worker/worker-launch-preferences'

export async function preflightFederatedWorkerLaunch(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  server: ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>
  status: RuntimeStatus
  worktree: string
  preflightTimeoutMs: number
  requestedLaunch: OrchestrationWorkerLaunchReceipt
}): Promise<OrchestrationWorkerLaunchReceipt> {
  const { params, runtime, server, status, worktree, preflightTimeoutMs } = args
  const pairingFence = { expectedEnvironmentPairingRevision: server.pairingRevision }
  let { requestedLaunch } = args
  if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      `Connected server ${server.name} does not support the current orchestration contract. No effects were applied.`,
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  if (!status.capabilities?.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} does not support orchestration federation.`
    )
  }
  assertWorkerLaunchPreferencesRuntimeSupported({
    model: params.model,
    effort: params.effort,
    fastMode: params.fastMode,
    role: params.role,
    capabilities: status.capabilities,
    serverName: server.name
  })
  if (params.role || params.fastMode !== undefined) {
    requestedLaunch = parseWorkerLaunchPreflight(
      await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.workerLaunchPreflight',
        {
          worktree,
          name: params.name,
          repo: params.repo,
          baseBranch: params.baseBranch,
          setup: params.setup,
          terminal: params.terminal,
          agent: params.agent,
          role: params.role,
          model: params.model,
          effort: params.effort,
          fastMode: params.fastMode
        },
        preflightTimeoutMs,
        undefined,
        { contractVerified: true, ...pairingFence }
      )
    )
    if (
      requestedLaunch.role !== params.role ||
      requestedLaunch.requested.model !== (params.model ?? null) ||
      requestedLaunch.requested.effort !== (params.effort ?? null) ||
      requestedLaunch.requested.fastMode !== params.fastMode ||
      (isTuiAgent(params.agent) && requestedLaunch.requested.agent !== params.agent)
    ) {
      throw new OrchestrationError(
        'capability_unsupported',
        'The execution host cannot honor the requested role launch. No effects were applied.',
        { effectsApplied: false }
      )
    }
  }
  return requestedLaunch
}
