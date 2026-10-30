import {
  ORCAD_WSL_HOLDER_BLOCKED_FILENAME,
  ORCAD_WSL_HOLDER_RELEASE_FILENAME
} from '../../shared/orcad-idle-exit'
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

/** At most this many process names go into the blocked note, so a busy distro stays cheap. */
export const WSL_DISTRO_HOLDER_BLOCKED_NAMES_MAX = 5

// Why short sleeps: busybox `sleep` (Alpine) rejects `infinity`. Why `rm` without -f: it claims the
// request atomically, so an orcad that starts and clears it first keeps the holder (and the distro).
// `~/.orca` is the WSL host's data root (orcad-remote-context); without HOME the path never exists.
export function buildWslDistroHolderScript(
  pollSeconds = WSL_DISTRO_HOLDER_POLL_SECONDS,
  procRoot = '/proc'
): string {
  const ignored = WSL_DISTRO_HOLDER_IGNORED_PROCESS_NAMES.map((name) => `'${name}'`).join('|')
  return [
    `f="$HOME/.orca/${ORCAD_WSL_HOLDER_RELEASE_FILENAME}"; b="$HOME/.orca/${ORCAD_WSL_HOLDER_BLOCKED_FILENAME}"; me=$(id -u)`,
    // A new holder means a client wants the distro: an older orcad's request no longer stands.
    // Also any note half-written by a holder killed mid-write.
    'rm -f "$f" "$b" "$b".*',
    // Fails toward holding: any live process of this user outside the holder itself counts, so a
    // distro whose default user is root never releases; so does a /proc it cannot read, or a
    // status file it cannot parse. One exception: with /proc mounted hidepid, another user's
    // container shim is invisible and does not hold. Leaves the first names it found in $why.
    'user_busy() {',
    'why=; c=0',
    `[ -r "${procRoot}/$$/status" ] || { why=proc-unreadable; return 0; }`,
    `for d in ${procRoot}/[0-9]*; do`,
    '[ "${d##*/}" = "$$" ] && continue',
    'n= s= pp= u=',
    '{ while read -r k v r; do case $k in Name:) n=$v ;; State:) s=$v ;; PPid:) pp=$v ;; Uid:) u=$v; break ;; esac',
    'done < "$d/status"; } 2>/dev/null',
    // A process that vanished mid-scan is gone; one still there that cannot be read counts only
    // when its entry is this user's (hidepid=noaccess hides root's status files, not their dirs).
    '[ -n "$u" ] || { [ -d "$d" ] || continue; set -- $(ls -nd "$d" 2>/dev/null); [ "${3:-}" = "$me" ] || continue; n=${n:-unreadable}; u=$me; }',
    // A running container is work whoever owns it (docker's shims run as root).
    'case $n in containerd-shim*) ;; *)',
    '[ "$u" = "$me" ] && [ "$pp" != "$$" ] || continue',
    'case $s in Z*) continue ;; esac',
    `case $n in ${ignored}) continue ;; esac ;;`,
    'esac',
    `why="$why $n"; c=$((c + 1)); [ "$c" -lt ${WSL_DISTRO_HOLDER_BLOCKED_NAMES_MAX} ] || return 0`,
    'done; [ -n "$why" ]; }',
    `while :; do sleep ${pollSeconds}`,
    '[ -f "$f" ] || continue',
    'p=; read -r p < "$f"',
    "case $p in ''|*[!0-9]*) continue ;; esac",
    'while kill -0 "$p" 2>/dev/null; do sleep 1; done',
    // Why still held, for the desktop to read later (replaced whole); cleared on release.
    'if user_busy; then',
    // Rewritten only when it changed, so a long hold costs no writes.
    '[ "$(cat "$b" 2>/dev/null)" = "${why# }" ] || { printf \'%s\\n\' "${why# }" > "$b.$$" && mv -f "$b.$$" "$b"; } 2>/dev/null',
    'continue; fi',
    'rm -f "$b"',
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
