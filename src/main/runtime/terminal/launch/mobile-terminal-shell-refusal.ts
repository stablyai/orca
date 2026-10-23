import {
  resolveLocalTerminalRuntime,
  type LocalTerminalRuntimeStore
} from '../../../local-project-runtime-resolution'
import { terminalShellOverrideRefusal } from '../../terminal-shell-override-host-support'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'

/** Throws before any surface exists when this host cannot run the requested shell. */
export function assertMobileTerminalShellSupported(
  store: LocalTerminalRuntimeStore | null | undefined,
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
    projectRuntime: store ? resolveLocalTerminalRuntime(store, workspace.id) : undefined,
    cwd: cwd ?? workspace.path,
    workspacePath: workspace.path
  })
  if (refusal) {
    throw refusal
  }
}
