import {
  resolveLocalLaunchScopeRuntime,
  type LaunchScopeRuntimeStore
} from '../../../local-project-runtime-resolution'
import { terminalShellOverrideRefusal } from '../../terminal-shell-override-host-support'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'

/** Throws before any surface exists when this host cannot run the requested shell. */
export function assertMobileTerminalShellSupported(
  store: LaunchScopeRuntimeStore | null | undefined,
  workspace: TerminalWorkspaceLaunchScope,
  shellOverride: string | undefined,
  cwd: string | undefined
): void {
  if (!shellOverride) {
    return
  }
  const refusal = terminalShellOverrideRefusal({
    shellOverride,
    connectionId: workspace.connectionId,
    platform: process.platform,
    // Why the launch scope: a folder workspace's runtime comes from its project, not a repo id.
    projectRuntime: store ? resolveLocalLaunchScopeRuntime(store, workspace) : undefined,
    cwd: cwd ?? workspace.path,
    workspacePath: workspace.path
  })
  if (refusal) {
    throw refusal
  }
}
