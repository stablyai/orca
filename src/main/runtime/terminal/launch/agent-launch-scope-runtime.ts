import { resolveTerminalStartupCwd } from '../../../../shared/shell/launch/terminal-startup-cwd'
import { resolveTuiAgentLaunchEnv } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import {
  selectEffectiveTerminalExecutionContext,
  TERMINAL_EXECUTION_CONTEXT_UNRESOLVED
} from '../../../../shared/terminal/effective-terminal-execution-context'
import { getWslContextFromWorktreeId } from '../../../providers/local-pty/local-pty-launch-context'
import { listWslDistrosAsync } from '../../../wsl/discovery/distro-catalog'
import {
  agentLaunchQuotingShell,
  executionRuntimePlatform,
  remoteExecutionPlatform,
  type AgentLaunchRuntime
} from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import type { AgentStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getRepoSshConnectionId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { getWorktreePathSettings } from '../../../ipc/worktree-logic'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import {
  resolveLocalLaunchScopeRuntime,
  resolveLocalProjectRuntimeForWorktreeId,
  type LaunchScopeRuntimeStore
} from '../../../workspaces/execution-host/local-project-runtime-resolution'
import { resolveLocalPtyOptions } from '../../../workspaces/execution-host/local-project-runtime-pty-options'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  agentLaunchRepairRefusal,
  PROJECT_RUNTIME_REPAIR_REQUIRED_CODE
} from '../../../../shared/project-runtime-repair-message'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'

type AgentLaunchRuntimeStore = Omit<LaunchScopeRuntimeStore, 'getSettings'> &
  Pick<RuntimeStore, 'getSettings'>

/** Quoting platform; unlike full runtime resolution, this never throws. */
export function agentLaunchPlatformForScope(
  store: LaunchScopeRuntimeStore,
  scope: TerminalWorkspaceLaunchScope
): NodeJS.Platform {
  return scope.connectionId
    ? remoteExecutionPlatform(scope.path)
    : executionRuntimePlatform(
        resolveLocalLaunchScopeRuntime(store, scope),
        scope.path,
        process.platform
      )
}

/** Apply runtime policy with UNC path authority and temporary folder/OpenCode parity exceptions below. */
export function agentLaunchProjectRuntime(
  store: LaunchScopeRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  agent: TuiAgent | undefined
): ProjectExecutionRuntimeResolution | undefined {
  const runtime = resolveLocalLaunchScopeRuntime(store, scope)
  const onWindowsHost = runtime?.status === 'resolved' && runtime.runtime.kind === 'windows-host'
  // Folders can lack project runtime; local repositories have one.
  const mainHadNone = !resolveLocalProjectRuntimeForWorktreeId(store, scope.id)
  const pathDecides =
    // UNC cwd proves WSL execution regardless of Windows-host settings; retain beyond the temporary exceptions.
    (onWindowsHost && isWslUncPath(scope.path)) ||
    // TEMPORARY (STA-10231): an explicit Windows host can't be told from the shipped default.
    (onWindowsHost && mainHadNone) ||
    // TEMPORARY (STA-10251): OpenCode models can't yet be verified inside WSL.
    (agent === 'opencode' && mainHadNone)
  return pathDecides ? undefined : runtime
}

/** Resolve the launch runtime; report repair-required using its typed code and settings guidance. */
export function resolveAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  requestedShellOverride: string | undefined,
  agent: TuiAgent | undefined
): AgentLaunchRuntime {
  if (scope.connectionId) {
    return {
      platform: remoteExecutionPlatform(scope.path),
      pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
    }
  }
  const projectRuntime = agentLaunchProjectRuntime(store, scope, agent)
  // Match spawn refusal before launching, on Windows only.
  if (process.platform === 'win32' && projectRuntime?.status === 'repair-required') {
    // The launch ledger preserves refusal codes only from OrchestrationError.
    throw new OrchestrationError(
      PROJECT_RUNTIME_REPAIR_REQUIRED_CODE,
      agentLaunchRepairRefusal(projectRuntime.repair)
    )
  }
  return {
    platform: executionRuntimePlatform(projectRuntime, scope.path, process.platform),
    pty: resolveLocalPtyOptions(store.getSettings(), projectRuntime, requestedShellOverride)
  }
}

/** New worktrees use a configured WSL base directory, otherwise the repo filesystem. */
export function newWorktreeLaunchScope(
  repo: Repo,
  settings: Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'>
): TerminalWorkspaceLaunchScope {
  const base = getWorktreePathSettings(repo, settings).workspaceDir
  const connectionId = getRepoSshConnectionId(repo)
  return {
    id: repo.id,
    path: !connectionId && !isFolderRepo(repo) && isWslUncPath(base) ? base : repo.path,
    connectionId,
    repo,
    folderWorkspace: null
  }
}

/** Resolve before terminal creation; repair failure leaves worktree creation intact and quotes the failed startup for Settings shell. */
export function resolveStartupAgentLaunchRuntime(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  agent: TuiAgent
): {
  platform: NodeJS.Platform
  shell: AgentStartupShell | undefined
  launchRuntime: AgentLaunchRuntime | Error
} {
  try {
    const launchRuntime = resolveAgentLaunchRuntime(store, scope, undefined, agent)
    return {
      platform: launchRuntime.platform,
      shell: agentLaunchQuotingShell(launchRuntime),
      launchRuntime
    }
  } catch (error) {
    return {
      platform: agentLaunchPlatformForScope(store, scope),
      shell: undefined,
      launchRuntime: error instanceof Error ? error : new Error(String(error))
    }
  }
}

/** Startup and inventory use the same workspace root when no directory was requested. */
export function effectiveTerminalStartupCwd(path: string, requestedCwd?: string | null): string {
  return resolveTerminalStartupCwd(path, requestedCwd) ?? path
}

/** Resolve the probe's launch context without creating a terminal or workspace. */
export async function resolveAgentTerminalDiscoveryLaunch(
  store: AgentLaunchRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  agent: TuiAgent,
  requestedCwd?: string,
  hostGlobal = false
) {
  const runtime = resolveAgentLaunchRuntime(store, scope, undefined, agent)
  const settings = store.getSettings()
  const cwd = hostGlobal ? undefined : effectiveTerminalStartupCwd(scope.path, requestedCwd)
  const inputs = {
    platform: process.platform,
    cwd,
    worktreeContext: getWslContextFromWorktreeId(scope.id),
    shell:
      runtime.pty.shellOverride ||
      settings.terminalWindowsShell ||
      process.env.COMSPEC ||
      'powershell.exe',
    preferredDistro: runtime.pty.terminalWindowsWslDistro
  }
  let selected = selectEffectiveTerminalExecutionContext(inputs)
  if (selected.kind === 'unresolved-wsl') {
    selected = selectEffectiveTerminalExecutionContext({
      ...inputs,
      defaultDistro: (await listWslDistrosAsync())[0]
    })
  }
  if (selected.kind === 'unresolved-wsl') {
    throw new Error(TERMINAL_EXECUTION_CONTEXT_UNRESOLVED)
  }
  const wslDistro = selected.kind === 'wsl' ? selected.context.distro : undefined
  return {
    cwd,
    wslDistro,
    command: settings.agentCmdOverrides?.[agent],
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings, wslDistro ? 'linux' : process.platform)
  }
}
