import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { resolveWslSessionContext } from '../../../daemon/pty-subprocess/wsl-session-context'
import { agentLaunchProjectRuntime } from '../../terminal/launch/agent-launch-scope-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  agentLaunchRepairRefusal,
  PROJECT_RUNTIME_REPAIR_REQUIRED_CODE
} from '../../../../shared/execution-host/project-runtime-repair-message'
import type { LaunchScopeRuntimeStore } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import { resolveLocalWindowsTerminalRuntimeOptions } from '../../../../shared/shell/launch/local-windows-terminal-runtime'

/**
 * Distro where the terminal actually runs. A UNC path names its own distro, the same way
 * `resolveCommand` enters that guest. A repo-less folder uses the same shell as agent launch.
 */
export function modelDiscoveryWslDistro(
  store: LaunchScopeRuntimeStore,
  scope: TerminalWorkspaceLaunchScope
): string | undefined {
  if (process.platform !== 'win32' || scope.connectionId) {
    return undefined
  }
  const projectRuntime = agentLaunchProjectRuntime(store, scope, undefined)
  // Match terminal launch: a missing distro is a refusal, not an execution target.
  if (projectRuntime?.status === 'repair-required') {
    throw new OrchestrationError(
      PROJECT_RUNTIME_REPAIR_REQUIRED_CODE,
      agentLaunchRepairRefusal(projectRuntime.repair)
    )
  }
  // OpenSSH login shells are PowerShell only and never select WSL, so skip the synchronous probe.
  const pty = resolveLocalWindowsTerminalRuntimeOptions({
    requestedShellOverride: undefined,
    settings: store.getSettings?.(),
    projectRuntime
  })
  return resolveWslSessionContext({
    cwd: scope.path,
    shellOverride: pty.shellOverride,
    terminalWindowsWslDistro: pty.terminalWindowsWslDistro
  })?.distro
}
