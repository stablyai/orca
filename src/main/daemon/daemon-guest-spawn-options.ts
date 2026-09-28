import type { PtySpawnOptions } from '../providers/types'
import type { GuestDaemonExecution } from './daemon-pty-runtime-state'
import { normalizeWslColdRestoreCwd } from './wsl-cold-restore-cwd'

export function guestDaemonSpawnOptions(
  guest: GuestDaemonExecution,
  options: PtySpawnOptions
): PtySpawnOptions {
  const cwd = normalizeWslColdRestoreCwd({
    recoveredCwd: options.cwd ?? guest.defaultCwd,
    wslDistro: guest.distro,
    guestExecution: true
  })
  if (!cwd) {
    throw new Error('Guest daemon spawn requires a path in its selected distro')
  }
  return {
    ...options,
    cwd,
    shellOverride: options.shellOverride || guest.defaultShell,
    terminalWindowsWslDistro: undefined,
    terminalWindowsPowerShellImplementation: undefined
  }
}
