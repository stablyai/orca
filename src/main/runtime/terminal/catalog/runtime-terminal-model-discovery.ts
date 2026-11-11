import { isRepoOnCatalogHost } from '../../../../shared/execution-host'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import {
  selectEffectiveTerminalExecutionContext,
  TERMINAL_EXECUTION_CONTEXT_UNRESOLVED
} from '../../../../shared/terminal/effective-terminal-execution-context'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../../shared/project-runtime-repair-message'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedTerminalWorkspaceLaunchTarget } from '../launch/terminal-workspace-launch-target'
import { resolveAgentLaunchRuntime } from '../launch/agent-launch-scope-runtime'
import { getWslContextFromWorktreeId } from '../../../providers/local-pty/local-pty-launch-context'
import { listWslDistrosAsync } from '../../../wsl/discovery/distro-catalog'
import { resolveTerminalStartupCwd } from '../../../../shared/shell/launch/terminal-startup-cwd'
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
    const runtime = resolveAgentLaunchRuntime(context.store, scope, undefined, agentId)
    const shell =
      runtime.pty.shellOverride ||
      context.store.getSettings().terminalWindowsShell ||
      process.env.COMSPEC ||
      'powershell.exe'
    const inputs = {
      platform: process.platform,
      cwd: resolveTerminalStartupCwd(scope.path, context.cwd),
      worktreeContext: getWslContextFromWorktreeId(scope.id),
      shell,
      preferredDistro: runtime.pty.terminalWindowsWslDistro
    }
    let selected = selectEffectiveTerminalExecutionContext(inputs)
    if (selected.kind === 'unresolved-wsl' && isWslShellName(shell)) {
      selected = selectEffectiveTerminalExecutionContext({
        ...inputs,
        defaultDistro: (await listWslDistrosAsync())[0]
      })
    }
    if (selected.kind === 'unresolved-wsl') {
      return { success: false, error: TERMINAL_EXECUTION_CONTEXT_UNRESOLVED }
    }
    const wslDistro = selected.kind === 'wsl' ? selected.context.distro : undefined
    const env = await prepareLocalCommitMessageAgentEnv(
      agentId,
      context.environment,
      wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
    )
    if (!env.ok) {
      return { success: false, error: env.error }
    }
    return await discoverCommitMessageModelsLocal(
      agentId,
      env.env,
      context.store.getSettings().agentCmdOverrides?.[agentId],
      {
        ...(inputs.cwd ? { cwd: inputs.cwd } : {}),
        ...(context.uncached ? { uncached: true } : {}),
        ...(wslDistro ? { wslDistro } : {}),
        ...(agentId === 'antigravity'
          ? {
              agentEnv: resolveTuiAgentLaunchEnv(
                agentId,
                context.store.getSettings(),
                wslDistro ? 'linux' : process.platform
              ),
              useCwdForNative: true
            }
          : {})
      }
    )
  } catch (error) {
    if (
      (error instanceof OrchestrationError &&
        error.code === PROJECT_RUNTIME_REPAIR_REQUIRED_CODE) ||
      (error instanceof Error &&
        ['floating_workspace_path_unavailable', 'selector_not_found'].includes(error.message))
    ) {
      return { success: false, error: error.message }
    }
    throw error
  }
}
