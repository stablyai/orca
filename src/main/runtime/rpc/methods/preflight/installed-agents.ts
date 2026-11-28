import type { z } from 'zod'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { AGENT_MODEL_CATALOG_REQUEST_TIMEOUT_MS } from '../../../../../shared/agent-session/options/model-catalog/agent-model-catalog-request-timeout'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { parseRoutableExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { PreflightAgentDetection } from '../../../../../shared/rpc-contract/preflight/preflight-params'
import { getSshHostServerStatus } from '../../../../ssh/host-server/ssh-host-server-status'
import { SshHostNotServedError } from '../../../../providers/ssh-host-not-served-error'
import {
  assertAgentDetectionHostRunning,
  detectAgentsOnHost,
  type AgentDetectionHost
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

type AgentHostRead =
  | { method: 'preflight.installedAgents' }
  | { method: 'preflight.agentModels'; agent: string }

export async function readOnWorkspaceAgentHost(
  runtime: InstalledAgentsRuntime,
  params: z.infer<typeof PreflightAgentDetection>,
  read: AgentHostRead,
  onHost: (host: AgentDetectionHost, workspacePath?: string) => Promise<unknown>
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
          read.method,
          // The execution owner must hold this workspace locally; never follow a pairing cycle.
          {
            worktreeId: worktree.id,
            worktreeHostId: 'local',
            ...(read.method === 'preflight.agentModels' ? { agent: read.agent } : {})
          },
          read.method === 'preflight.agentModels'
            ? AGENT_MODEL_CATALOG_REQUEST_TIMEOUT_MS
            : undefined,
          undefined,
          { expectedEnvironmentPairingRevision: server.pairingRevision }
        )
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'method_not_found') {
          throw new OrchestrationError(
            'incompatible_runtime',
            read.method === 'preflight.agentModels'
              ? 'Update Orca on the workspace host to list its agent models.'
              : 'Update Orca on the workspace host to list its installed agents.'
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
  return onHost(host, selectedWorktree?.path ?? selectedFolder?.workspace.folderPath)
}

export function listInstalledWorkspaceAgents(
  runtime: InstalledAgentsRuntime,
  params: z.infer<typeof PreflightAgentDetection>
) {
  return readOnWorkspaceAgentHost(
    runtime,
    params,
    { method: 'preflight.installedAgents' },
    (host) => readInstalledAgentsOnHost(runtime, host)
  )
}

export async function readInstalledAgentsOnHost(
  runtime: InstalledAgentsRuntime,
  host: AgentDetectionHost,
  onlyTuiAgent?: TuiAgent
) {
  await assertAgentDetectionHostRunning(host)
  const settings = runtime.requireStore().getSettings()
  const overrides = agentCommandOverrideDetectionOptions(settings.agentCmdOverrides)
  return {
    agents: await detectAgentsOnHost(
      host,
      onlyTuiAgent ? { ...overrides, onlyTuiAgent } : overrides
    ),
    settings: {
      disabledTuiAgents: settings.disabledTuiAgents,
      defaultTuiAgent: settings.defaultTuiAgent
    }
  }
}
