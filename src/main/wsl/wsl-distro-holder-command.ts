import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'

/** `$0` of the holder's shell; the token that identifies our holder in a process command line. */
export const WSL_DISTRO_HOLDER_MARKER = 'orca-wsl-distro-holder'

// Use bounded sleeps: BusyBox rejects infinity and huge durations vary across implementations.
const HOLDER_SCRIPT = 'while :; do sleep 3600; done'

/** `wsl.exe` argv for a holder: only a Windows-side WSL client keeps a distro from idling out. */
export function buildWslDistroHolderArgs(distro: string): string[] {
  return buildWslExecArgs(distro, ['/bin/sh', '-c', HOLDER_SCRIPT, WSL_DISTRO_HOLDER_MARKER])
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether a Windows command line is our holder for `distro` (distro names are case-insensitive). */
export function isWslDistroHolderCommandLine(commandLine: string, distro: string): boolean {
  if (!commandLine.includes(WSL_DISTRO_HOLDER_MARKER) || !/wsl(\.exe)?"?\s/i.test(commandLine)) {
    return false
  }
  const distroArg = new RegExp(`(^|\\s)-d\\s+("?)${escapeRegExp(distro)}\\2(\\s|$)`, 'i')
  return distroArg.test(commandLine)
}
