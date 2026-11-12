import { isRepoOnCatalogHost } from '../../../../shared/execution-host'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../../shared/project-runtime-repair-message'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedTerminalWorkspaceLaunchTarget } from '../launch/terminal-workspace-launch-target'
import { resolveAgentTerminalDiscoveryLaunch } from '../launch/agent-launch-scope-runtime'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../../../text-generation/commit-message-agent-environment'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../../../text-generation/commit-message-text-generation'

export async function discoverTerminalModels(
  context: {
    store: RuntimeStore
    resolveTarget: () => Promise<ResolvedTerminalWorkspaceLaunchTarget>
    hostGlobal?: true
    environment?: CommitMessageAgentEnvironmentResolvers
    uncached?: boolean
    cwd?: string
  },
  agentId: string
): Promise<DiscoverCommitMessageModelsResult> {
  if (!isTuiAgent(agentId)) {
    return { success: false, error: 'Unknown agent.' }
  }
  try {
    const target = context.hostGlobal ? undefined : await context.resolveTarget()
    const scope = target?.scope ?? {
      id: '',
      path: '',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }
    const owner = scope.folderWorkspace ?? scope.repo
    if (
      !isRepoOnCatalogHost({
        executionHostId: target?.managedWorktree?.hostId ?? owner?.executionHostId,
        connectionId: scope.connectionId ?? owner?.connectionId
      })
    ) {
      return {
        success: false,
        error: 'Terminal model discovery is unavailable on this connection.'
      }
    }
    const launch = await resolveAgentTerminalDiscoveryLaunch(
      context.store,
      scope,
      agentId,
      context.cwd,
      context.hostGlobal
    )
    const { wslDistro } = launch
    const env = await prepareLocalCommitMessageAgentEnv(
      agentId,
      context.environment,
      wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
    )
    if (!env.ok) {
      return { success: false, error: env.error }
    }
    return await discoverCommitMessageModelsLocal(agentId, env.env, launch.command, {
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      ...(context.uncached ? { uncached: true } : {}),
      ...(wslDistro ? { wslDistro } : {}),
      ...(agentId === 'antigravity'
        ? {
            agentEnv: launch.agentEnv,
            useCwdForNative: true
          }
        : {})
    })
  } catch (error) {
    if (
      (error instanceof OrchestrationError &&
        error.code === PROJECT_RUNTIME_REPAIR_REQUIRED_CODE) ||
      (error instanceof Error &&
        [
          'floating_workspace_path_unavailable',
          'selector_not_found',
          'terminal_execution_context_unresolved'
        ].includes(error.message))
    ) {
      return { success: false, error: error.message }
    }
    throw error
  }
}
