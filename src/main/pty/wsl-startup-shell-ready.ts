// Hold a WSL pane's startup command until the guest shell reads, or cold zsh drops it (#24188).
import { win32 as pathWin32 } from 'node:path'
import { addWslEnvKeys } from '../wsl-env'
import { SHELL_STARTUP_FEATURE_ENV } from '../shell-startup-features'

// Covers a cold distro boot; matches the daemon default, and timing out still sends the command.
export const WSL_SHELL_READY_TIMEOUT_MS = 15_000

export function wslStartupCommandWaitsForShellReady(args: {
  shellPath: string | undefined
  command: string | undefined
  startupCommandDeliveredInShellArgs: boolean | undefined
  platform?: NodeJS.Platform
}): boolean {
  return (
    (args.platform ?? process.platform) === 'win32' &&
    Boolean(args.command) &&
    args.startupCommandDeliveredInShellArgs !== true &&
    args.shellPath !== undefined &&
    pathWin32.basename(args.shellPath).toLowerCase() === 'wsl.exe'
  )
}

/** Asks the guest's bash/zsh wrapper or fish prompt hook for the marker; other shells time out. */
export function requestWslShellReadyMarker(env: Record<string, string>): void {
  env[SHELL_STARTUP_FEATURE_ENV] = 'ready'
  // wsl.exe imports only the Windows env vars that WSLENV names.
  addWslEnvKeys(env, [SHELL_STARTUP_FEATURE_ENV])
}
