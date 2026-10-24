import { ORCAD_WSL_HOLDER_RELEASE_FILENAME } from '../../shared/orcad-idle-exit'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'

/** `$0` of the holder's shell; the token that identifies our holder in a process command line. */
export const WSL_DISTRO_HOLDER_MARKER = 'orca-wsl-distro-holder'

/** How often the holder looks for orcad's release request; also the floor on how soon it ends. */
export const WSL_DISTRO_HOLDER_POLL_SECONDS = 15

// Why short sleeps: busybox `sleep` (Alpine) rejects `infinity`. Why `rm` without -f: it claims the
// request atomically, so an orcad that starts and clears it first keeps the holder (and the distro).
// `~/.orca` is the WSL host's data root (orcad-remote-context); without HOME the path never exists.
export function buildWslDistroHolderScript(pollSeconds = WSL_DISTRO_HOLDER_POLL_SECONDS): string {
  return [
    `f="$HOME/.orca/${ORCAD_WSL_HOLDER_RELEASE_FILENAME}"`,
    `while :; do sleep ${pollSeconds}`,
    '[ -f "$f" ] || continue',
    'p=; read -r p < "$f"',
    "case $p in ''|*[!0-9]*) continue ;; esac",
    'while kill -0 "$p" 2>/dev/null; do sleep 1; done',
    'rm "$f" 2>/dev/null && exit 0',
    'done'
  ].join('\n')
}

/** `wsl.exe` argv for a holder: only a Windows-side WSL client keeps a distro from idling out. */
export function buildWslDistroHolderArgs(distro: string): string[] {
  return buildWslExecArgs(distro, [
    '/bin/sh',
    '-c',
    buildWslDistroHolderScript(),
    WSL_DISTRO_HOLDER_MARKER
  ])
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
