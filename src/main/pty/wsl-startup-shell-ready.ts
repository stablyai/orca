/**
 * Holds a WSL pane's startup command until the guest shell reports ready.
 *
 * Why: a startup command typed into `wsl.exe` right after spawn reaches the
 * guest before the distro has booted and the login shell has read its config.
 * zsh (oh-my-zsh and friends) then drops it, and the pane shows the command
 * echoed above a fresh prompt with nothing running (#24188). The guest login
 * script already starts bash and zsh through Orca's wrappers, which emit the
 * OSC 777 ready marker when asked; the host just never asked across wsl.exe.
 */
import { win32 as pathWin32 } from 'node:path'
import { addWslEnvKeys } from '../wsl-env'
import { SHELL_STARTUP_FEATURE_ENV } from '../shell-startup-features'

/**
 * Why this long: the first pane after `wsl --shutdown` or a reboot pays the
 * distro's cold start. Matches the daemon's default so both transports give
 * up at the same point, and giving up still delivers the command.
 */
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

/** Asks the guest's bash/zsh wrapper or fish prompt hook for the ready marker; other shells time out. */
export function requestWslShellReadyMarker(env: Record<string, string>): void {
  env[SHELL_STARTUP_FEATURE_ENV] = 'ready'
  // Why: wsl.exe only imports Windows env vars that WSLENV names.
  addWslEnvKeys(env, [SHELL_STARTUP_FEATURE_ENV])
}
