import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { parseRoutableExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { PreflightAgentDetection } from '../../../../../shared/rpc-contract/preflight/preflight-params'
import { getSshHostServerStatus } from '../../../../ssh/host-server/ssh-host-server-status'
import { SshHostNotServedError } from '../../../../providers/ssh-host-not-served-error'
import {
  assertAgentDetectionHostRunning,
  detectAgentsOnHost
} from '../../../../preflight/workspace-agent-detection'
import { agentCommandOverrideDetectionOptions } from '../../../../preflight/installed-agent-detection'
import { resolveQualifiedAgentDetectionHost } from './preflight-workspace-target'

type InstalledAgentsRuntime = Pick<
  OrcaRuntimeService,
  | 'showManagedWorktree'
  | 'requireStore'
  | 'resolveAgentDetectionHost'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
>

export async function listInstalledWorkspaceAgents(
  runtime: InstalledAgentsRuntime,
  params: z.infer<typeof PreflightAgentDetection>
) {
  if (params.worktreeId) {
    const worktree = await runtime.showManagedWorktree(
      `id:${params.worktreeId}`,
      params.worktreeHostId,
      { matchFolders: true }
    )
    const host = parseRoutableExecutionHostId(worktree.hostId)
    if (!host) {
      throw new Error('worktree_execution_host_unresolved')
    }
    let environmentId: string | undefined
    if (host.kind === 'runtime') {
      environmentId = host.environmentId
    } else if (host.kind === 'ssh') {
      const server = getSshHostServerStatus(host.targetId)
      if (server?.kind !== 'managed') {
        throw new SshHostNotServedError(host.targetId)
      }
      environmentId = server.environmentId
    }
    if (environmentId) {
      const server = await runtime.resolveOrchestrationWorkerServer(environmentId)
      return runtime.callOrchestrationWorkerServer(
        environmentId,
        'preflight.installedAgents',
        // The execution owner must hold this workspace locally; never follow a pairing cycle.
        { worktreeId: worktree.id, worktreeHostId: 'local' },
        undefined,
        undefined,
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )
    }
  }
  const host = await resolveQualifiedAgentDetectionHost(runtime, params)
  await assertAgentDetectionHostRunning(host)
  const settings = runtime.requireStore().getSettings()
  return {
    agents: await detectAgentsOnHost(
      host,
      agentCommandOverrideDetectionOptions(settings.agentCmdOverrides)
    ),
    settings: {
      disabledTuiAgents: settings.disabledTuiAgents,
      defaultTuiAgent: settings.defaultTuiAgent
    }
  }
}
