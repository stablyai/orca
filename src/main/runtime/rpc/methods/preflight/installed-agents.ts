import { normalizeAgentCopies } from '../../../../../shared/agent-launch/catalog/agent-copies'
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
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

type InstalledAgentsRuntime = Pick<
  OrcaRuntimeService,
  | 'showManagedWorktree'
  | 'resolveManagedFolderWorkspace'
  | 'requireStore'
  | 'resolveAgentDetectionHost'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
>

export async function listInstalledWorkspaceAgents(
  runtime: InstalledAgentsRuntime,
  params: z.infer<typeof PreflightAgentDetection>
) {
  let selectedWorktree:
    | Awaited<ReturnType<InstalledAgentsRuntime['showManagedWorktree']>>
    | undefined
  let selectedFolder:
    | NonNullable<ReturnType<InstalledAgentsRuntime['resolveManagedFolderWorkspace']>>
    | undefined
  if (params.worktreeId) {
    if (parseWorkspaceKey(params.worktreeId)?.type === 'folder') {
      selectedFolder =
        runtime.resolveManagedFolderWorkspace(params.worktreeId, params.worktreeHostId) ?? undefined
      if (!selectedFolder) {
        throw new Error('selector_not_found')
      }
    }
    const worktree = selectedFolder
      ? { id: params.worktreeId, hostId: selectedFolder.hostId }
      : (selectedWorktree = await runtime.showManagedWorktree(
          `id:${params.worktreeId}`,
          params.worktreeHostId
        ))
    const host = parseRoutableExecutionHostId(worktree.hostId)
    if (!host || (params.worktreeHostId && params.worktreeHostId !== worktree.hostId)) {
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
      try {
        return await runtime.callOrchestrationWorkerServer(
          environmentId,
          'preflight.installedAgents',
          // The execution owner must hold this workspace locally; never follow a pairing cycle.
          { worktreeId: worktree.id, worktreeHostId: 'local' },
          undefined,
          undefined,
          { expectedEnvironmentPairingRevision: server.pairingRevision }
        )
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'method_not_found') {
          throw new OrchestrationError(
            'incompatible_runtime',
            'Update Orca on the workspace host to list its installed agents.'
          )
        }
        if (
          host.kind === 'ssh' &&
          error instanceof OrchestrationError &&
          error.code === 'selector_not_found'
        ) {
          throw new SshHostNotServedError(host.targetId)
        }
        throw error
      }
    }
  }
  const host = await resolveQualifiedAgentDetectionHost(
    runtime,
    params.worktreeId
      ? { ...params, worktreeHostId: selectedFolder?.hostId ?? selectedWorktree?.hostId }
      : params,
    selectedWorktree,
    selectedFolder
  )
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
    },
    copies: normalizeAgentCopies(settings.agentCopies).map(({ id, name, agent }) => ({
      id,
      name,
      agent
    }))
  }
}
