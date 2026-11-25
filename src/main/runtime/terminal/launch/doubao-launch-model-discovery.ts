import type { OrcaRuntimeService } from '../../orca-runtime'
import { wslDistroForCommand } from '../../../../shared/file-access/wsl-paths'
import { isWslShellName } from '../../../../shared/shell/launch/local-windows-terminal-runtime'
import { discoverCommitMessageModelsLocal } from '../../../text-generation/commit-message-text-generation'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'
import { resolveHostAgentBaseEnvironment } from '../../agent-session/environment/structured-agent-shell-environment'
import { newWorktreeLaunchScope, resolveAgentLaunchRuntime } from './agent-launch-scope-runtime'

export async function discoverDoubaoLaunchModels(
  runtime: OrcaRuntimeService,
  target: { repo: string } | { worktree: string },
  commandOverride?: string
): Promise<DiscoverCommitMessageModelsResult> {
  const store = runtime.requireStore()
  const settings = store.getSettings()
  const scope =
    'repo' in target
      ? newWorktreeLaunchScope(await runtime.showRepo(target.repo), settings)
      : await runtime.resolveTerminalWorkspaceLaunchScope(target.worktree, undefined, {
          readOnly: true
        })
  if (
    scope.connectionId ||
    (scope.repo?.executionHostId && scope.repo.executionHostId !== 'local')
  ) {
    return {
      success: false,
      error: 'Doubao model discovery requires a connection to the runtime serving this workspace.'
    }
  }
  const launch = resolveAgentLaunchRuntime(store, scope, undefined, 'doubao')
  const wslShell = isWslShellName(launch.pty.shellOverride)
  const distro = wslDistroForCommand(
    scope.path,
    wslShell ? (launch.pty.terminalWindowsWslDistro ?? undefined) : undefined
  )
  if (process.platform === 'win32' && !distro && (wslShell || launch.platform === 'linux')) {
    return {
      success: false,
      error: 'Select a WSL distribution for this workspace to discover its Doubao models.'
    }
  }
  return discoverCommitMessageModelsLocal(
    'doubao',
    distro ? undefined : await resolveHostAgentBaseEnvironment(settings),
    commandOverride ?? settings.agentCmdOverrides?.doubao,
    {
      cwd: scope.path,
      wslDistro: distro ?? undefined,
      agentEnv: { ...settings.agentDefaultEnv?.doubao, DOUBAO_CLI_NO_UPDATE_CHECK: '1' }
    }
  )
}
