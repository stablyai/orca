import {
  resolveLocalLaunchScopeRuntime,
  type LaunchScopeRuntimeStore
} from '../../../workspaces/execution-host/local-project-runtime-resolution'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import { listWindowsTerminalShellChoices } from '../../../../shared/shell/launch/windows-terminal-shell-choices'
import type { BuiltInWindowsTerminalShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { isGitBashAvailableAsync } from '../../../pty/shell-startup/git-bash'
import { isWslAvailableAsync } from '../../../wsl/discovery/wsl-availability'
import { homedir } from 'node:os'
import { isFloatingWorkspaceSelector } from '../../../../shared/workspace/identity/floating-workspace-worktree'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/workspace/identity/floating-workspace-id'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'

function mobileTerminalShellRefusal(
  store: LaunchScopeRuntimeStore | null | undefined,
  workspace: TerminalWorkspaceLaunchScope,
  shellOverride: string,
  cwd: string | undefined
): Error | null {
  return terminalShellOverrideRefusal({
    shellOverride,
    connectionId: workspace.connectionId,
    platform: process.platform,
    // Why the launch scope: a folder workspace's runtime comes from its project, not a repo id.
    projectRuntime: store ? resolveLocalLaunchScopeRuntime(store, workspace) : undefined,
    cwd: cwd ?? workspace.path,
    workspacePath: workspace.path
  })
}

/** Throws before any surface exists when this host cannot run the requested shell. */
export function assertMobileTerminalShellSupported(
  store: LaunchScopeRuntimeStore | null | undefined,
  workspace: TerminalWorkspaceLaunchScope,
  shellOverride: string | undefined,
  cwd: string | undefined
): void {
  const refusal = shellOverride
    ? mobileTerminalShellRefusal(store, workspace, shellOverride, cwd)
    : null
  if (refusal) {
    throw refusal
  }
}

/**
 * Desktop's Windows shell menu entries this host would start in the workspace, its default first.
 * Reads only: the scope lookup skips launch preparation and the floating cwd is not resolved on disk,
 * since statting a WSL UNC path would start its distro.
 */
export async function listMobileTerminalShellChoices(
  store: LaunchScopeRuntimeStore | null | undefined,
  settings: { terminalWindowsShell?: string; floatingTerminalCwd?: string } | undefined,
  worktreeSelector: string,
  resolveReadOnlyScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
): Promise<BuiltInWindowsTerminalShell[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const workspace: TerminalWorkspaceLaunchScope = isFloatingWorkspaceSelector(worktreeSelector)
    ? {
        id: FLOATING_TERMINAL_WORKTREE_ID,
        path: settings?.floatingTerminalCwd?.trim() || homedir(),
        connectionId: null,
        repo: null,
        folderWorkspace: null
      }
    : await resolveReadOnlyScope(worktreeSelector)
  if (workspace.connectionId) {
    return []
  }
  const [gitBashAvailable, wslAvailable] = await Promise.all([
    isGitBashAvailableAsync(),
    isWslAvailableAsync()
  ])
  // Like desktop's menu, a project whose WSL runtime needs repair offers only WSL.
  const runtime = store ? resolveLocalLaunchScopeRuntime(store, workspace) : undefined
  return listWindowsTerminalShellChoices({
    defaultWindowsShell: settings?.terminalWindowsShell,
    gitBashAvailable,
    wslAvailable,
    includeHostShells: runtime?.status !== 'repair-required'
  }).filter((shell) => !mobileTerminalShellRefusal(store, workspace, shell, undefined))
}
