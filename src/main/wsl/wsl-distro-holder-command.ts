import { ORCAD_WSL_HOLDER_RELEASE_FILENAME } from '../../shared/orcad-idle-exit'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'

/** `$0` of the holder's shell; the token that identifies our holder in a process command line. */
export const WSL_DISTRO_HOLDER_MARKER = 'orca-wsl-distro-holder'

/** How often the holder looks for orcad's release request; also the floor on how soon it ends. */
export const WSL_DISTRO_HOLDER_POLL_SECONDS = 15

/**
 * The user's own processes that never make a distro "in use": session plumbing a login starts.
 * Kept tight on purpose; anything else the user runs (tmux, nohup jobs, servers) keeps the hold,
 * and so do long-lived per-user agents (gpg-agent, keyboxd, ssh-agent, an editor's server).
 */
export const WSL_DISTRO_HOLDER_IGNORED_PROCESS_NAMES = ['systemd', '(sd-pam)', 'dbus-daemon']

// Why short sleeps: busybox `sleep` (Alpine) rejects `infinity`. Why `rm` without -f: it claims the
// request atomically, so an orcad that starts and clears it first keeps the holder (and the distro).
// `~/.orca` is the WSL host's data root (orcad-remote-context); without HOME the path never exists.
export function buildWslDistroHolderScript(
  pollSeconds = WSL_DISTRO_HOLDER_POLL_SECONDS,
  procRoot = '/proc'
): string {
  const ignored = WSL_DISTRO_HOLDER_IGNORED_PROCESS_NAMES.map((name) => `'${name}'`).join('|')
  return [
    `f="$HOME/.orca/${ORCAD_WSL_HOLDER_RELEASE_FILENAME}"; me=$(id -u)`,
    // A new holder means a client wants the distro: an older orcad's request no longer stands.
    'rm -f "$f"',
    // Fails toward holding: any live process of this user outside the holder itself counts, so a
    // distro whose default user is root never releases. One exception: with /proc mounted
    // hidepid, another user's container shim is invisible and does not hold.
    'user_busy() {',
    `for d in ${procRoot}/[0-9]*; do`,
    'n= s= pp= u=',
    'while read -r k v r; do case $k in Name:) n=$v ;; State:) s=$v ;; PPid:) pp=$v ;; Uid:) u=$v; break ;; esac',
    'done 2>/dev/null < "$d/status" || continue',
    // A running container is work whoever owns it (docker's shims run as root).
    'case $n in containerd-shim*) return 0 ;; esac',
    '[ "$u" = "$me" ] && [ "${d##*/}" != "$$" ] && [ "$pp" != "$$" ] || continue',
    'case $s in Z*) continue ;; esac',
    `case $n in ${ignored}) continue ;; esac`,
    'return 0',
    'done; return 1; }',
    `while :; do sleep ${pollSeconds}`,
    '[ -f "$f" ] || continue',
    'p=; read -r p < "$f"',
    "case $p in ''|*[!0-9]*) continue ;; esac",
    'while kill -0 "$p" 2>/dev/null; do sleep 1; done',
    'user_busy && continue',
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
