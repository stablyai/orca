import {
  agentLaunchQuotingShell,
  executionRuntimePlatform,
  remoteExecutionPlatform,
  type AgentLaunchRuntime
} from '../../shared/agent-launch-runtime'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../shared/tui-agent'
import type { Repo } from '../../shared/repo-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getWorktreePathSettings } from '../ipc/worktree-logic'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import {
  resolveLocalLaunchScopeRuntime,
  resolveLocalProjectRuntimeForWorktreeId,
  resolveLocalPtyOptions,
  type LaunchScopeRuntimeStore
} from '../local-project-runtime-resolution'
import type { RuntimeStore } from './runtime-store-contract'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  agentLaunchRepairRefusal,
  PROJECT_RUNTIME_REPAIR_REQUIRED_CODE
} from '../../shared/project-runtime-repair-message'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'

type AgentLaunchRuntimeStore = Omit<LaunchScopeRuntimeStore, 'getSettings'> &
  Pick<RuntimeStore, 'getSettings'>

/** The platform an agent in this workspace is quoted for; never throws, unlike the full fact. */
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

/**
 * The runtime an agent launched here runs in: the window's rule, except where one of the terms
 * below holds. There the answer is no runtime, so the path places the agent and the Terminal shell
 * is its PTY, as on main. Only the first term is permanent; the other two are temporary parity.
 */
export function agentLaunchProjectRuntime(
  store: LaunchScopeRuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  agent: TuiAgent | undefined
): ProjectExecutionRuntimeResolution | undefined {
  const runtime = resolveLocalLaunchScopeRuntime(store, scope)
  const onWindowsHost = runtime?.status === 'resolved' && runtime.runtime.kind === 'windows-host'
  // Main had no runtime here: only folders, since every local repo has a project.
  const mainHadNone = !resolveLocalProjectRuntimeForWorktreeId(store, scope.id)
  const pathDecides =
    // PERMANENT fix, not parity: a `\\wsl$` cwd runs in WSL whatever the setting says. Keep it
    // when the temporary terms go; the window adopts it in C2.
    (onWindowsHost && isWslUncPath(scope.path)) ||
    // TEMPORARY (STA-10231): an explicit Windows host can't be told from the shipped default.
    (onWindowsHost && mainHadNone) ||
    // TEMPORARY (STA-10251): OpenCode models can't yet be verified inside WSL.
    (agent === 'opencode' && mainHadNone)
  return pathDecides ? undefined : runtime
}

/** The one runtime fact for an agent launched into this workspace. Throws, under
 *  `PROJECT_RUNTIME_REPAIR_REQUIRED_CODE` and in the settings page's words, when its runtime needs
 *  repair. */
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
  // Refused here, before any spawn, where the spawn would refuse it: Windows only.
  if (process.platform === 'win32' && projectRuntime?.status === 'repair-required') {
    // OrchestrationError because the launch record keeps a refusal's code only from that class.
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

/** A new worktree of this repo, before it exists: it lands under a `\\wsl$` base folder when one
 *  is set, else on the repo's own filesystem. */
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

/**
 * The fact for a startup agent, planned before its terminal is created. A runtime that needs repair
 * gives its error instead, so a worktree create goes on and the startup fails with that error as its
 * spawn would; that startup is quoted for the Settings shell.
 */
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
