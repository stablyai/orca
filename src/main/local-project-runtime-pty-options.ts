import type { GlobalSettings } from '../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import {
  resolveLocalWindowsTerminalRuntimeOptions,
  type LocalWindowsTerminalRuntimeOptions
} from '../shared/local-windows-terminal-runtime'
import { resolveManagedSshHostLoginShell } from './pty/managed-ssh-host-login-shell'

export type LocalPtySettings = Partial<
  Pick<GlobalSettings, 'terminalWindowsShell' | 'terminalWindowsWslDistro' | 'terminalDefaultShell'>
>

/** Throws for a Windows runtime that needs repair. */
export function resolveLocalPtyOptions(
  settings: LocalPtySettings | undefined,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  requestedShellOverride: string | undefined,
  /** Replaces a `wsl.exe` setting on a Windows-host runtime; absent is `powershell.exe`. */
  fallbackHostShell?: string
): LocalWindowsTerminalRuntimeOptions {
  return process.platform === 'win32'
    ? resolveLocalWindowsTerminalRuntimeOptions({
        requestedShellOverride,
        settings,
        projectRuntime,
        fallbackHostShell,
        sshLoginShell: resolveManagedSshHostLoginShell()
      })
    : {
        shellOverride: requestedShellOverride ?? (settings?.terminalDefaultShell || undefined),
        terminalWindowsWslDistro: null
      }
}
