import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  selectEffectiveTerminalExecutionContext,
  TERMINAL_EXECUTION_CONTEXT_UNRESOLVED
} from '../../../../shared/terminal/effective-terminal-execution-context'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { isProjectRuntimeRepairRefusal } from '../../../../shared/project-runtime-repair-message'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedTerminalWorkspaceLaunchTarget } from '../launch/terminal-workspace-launch-target'
import { resolveAgentLaunchRuntime } from '../launch/agent-launch-scope-runtime'
import { getWslContextFromWorktreeId } from '../../../providers/local-pty/local-pty-launch-context'
import { listWslDistrosAsync } from '../../../wsl/discovery/distro-catalog'
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
  },
  agentId: string
): Promise<DiscoverCommitMessageModelsResult> {
  if (!isTuiAgent(agentId)) {
    return { success: false, error: 'Unknown agent.' }
  }
  try {
    const scope = context.hostGlobal
      ? { id: '', path: '', connectionId: null, repo: null, folderWorkspace: null }
      : (await context.resolveTarget()).scope
    if (scope.connectionId) {
      return {
        success: false,
        error: 'Terminal model discovery is unavailable on this connection.'
      }
    }
    const runtime = resolveAgentLaunchRuntime(context.store, scope, undefined, agentId)
    const shell = runtime.pty.shellOverride || process.env.COMSPEC || 'powershell.exe'
    const inputs = {
      platform: process.platform,
      cwd: scope.path,
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
    return discoverCommitMessageModelsLocal(
      agentId,
      env.env,
      context.store.getSettings().agentCmdOverrides?.[agentId],
      {
        ...(scope.path ? { cwd: scope.path } : {}),
        ...(wslDistro ? { wslDistro } : {})
      }
    )
  } catch (error) {
    if (
      isProjectRuntimeRepairRefusal(error) ||
      (error instanceof Error &&
        ['floating_workspace_path_unavailable', 'selector_not_found'].includes(error.message))
    ) {
      return { success: false, error: error.message }
    }
    throw error
  }
}
