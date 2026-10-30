/** macOS pins Local Network attribution at spawn: SSH-launched terminals can lose LAN access after sshd-session exits (#25934; Apple TN3179). Record the nearest session plus start time and matching slot PID; preserve earlier attribution while a live terminal daemon survives orcad restarts. */
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_PID_FILENAME } from '../managed-server/install/orcad-remote-host-support'

export const ORCAD_LAUNCH_SSH_SESSION_FILENAME = '.orcad-launch-ssh-session'

const LOCAL_NETWORK_PRIVACY_MAJOR = 15
// Bounds the ancestor walk; real chains are a few processes deep.
const MAX_ANCESTOR_DEPTH = 32

export function recordsOrcadLaunchSshSession(host: RemoteHostPlatform): boolean {
  return host.os === 'darwin'
}

/** Choose the nearest sshd ancestor, which exits with this session; a listener farther up would remain alive. */
export function orcadSshSessionAncestorShellFunction(): string {
  return (
    'orcad_ssh_session() { orcad_sp=$1; orcad_si=0; ' +
    `while [ "$orcad_si" -lt ${MAX_ANCESTOR_DEPTH} ]; do ` +
    'case "$orcad_sp" in "" | *[!0-9]* | 0 | 1) return 1;; esac; ' +
    'orcad_sc=$(ps -o comm= -p "$orcad_sp" 2>/dev/null) || return 1; ' +
    'case "${orcad_sc##*/}" in sshd*) ' +
    'orcad_ss=$(ps -o lstart= -p "$orcad_sp" 2>/dev/null) || return 1; ' +
    // Why unquoted: normalizes lstart's padding so a later read compares equal.
    'echo "$orcad_sp" $orcad_ss; return 0;; esac; ' +
    'orcad_sp=$(ps -o ppid= -p "$orcad_sp" 2>/dev/null | tr -d " "); ' +
    'orcad_si=$((orcad_si + 1)); done; return 1; };'
  )
}

/** Capture before detach without failing launch. */
export function captureOrcadLaunchSshSessionCommand(): string {
  return (
    `${orcadSshSessionAncestorShellFunction()} ` +
    'orcad_session=$(orcad_ssh_session "$$" 2>/dev/null) || orcad_session=;'
  )
}

function recordPath(host: RemoteHostPlatform, userDataDir: string): string {
  return quotePosixShell(joinRemotePath(host, userDataDir, ORCAD_LAUNCH_SSH_SESSION_FILENAME))
}

/** Return 0 for this root's live daemon, 1 for absence, 2 for unreadable argv; PID files alone may name recycled processes. */
function liveDaemonShellFunction(host: RemoteHostPlatform, userDataDir: string): string {
  const daemonDir = quotePosixShell(joinRemotePath(host, userDataDir, 'daemon'))
  return (
    `orcad_daemon_live() { orcad_ddir=${daemonDir}; for orcad_df in "$orcad_ddir"/daemon-v*.pid; do ` +
    '[ -f "$orcad_df" ] || continue; ' +
    'orcad_dp=$(sed -n \'s/.*"pid":\\([0-9][0-9]*\\).*/\\1/p\' "$orcad_df" | head -n 1); ' +
    '[ -n "$orcad_dp" ] || continue; ' +
    'kill -0 "$orcad_dp" 2>/dev/null || continue; ' +
    'orcad_da=$(ps -o args= -p "$orcad_dp" 2>/dev/null); [ -n "$orcad_da" ] || return 2; ' +
    'case "$orcad_da" in *daemon-entry*"$orcad_ddir"* | *"$orcad_ddir"*daemon-entry*) return 0;; esac; ' +
    'done; return 1; };'
  )
}

/** After recording $!, preserve the live daemon's earlier session; otherwise record this launch's session. */
export function writeOrcadLaunchSshSessionCommand(
  host: RemoteHostPlatform,
  userDataDir: string
): string {
  const file = recordPath(host, userDataDir)
  return (
    // First-deploy detach may run before orcad creates its data root.
    `{ orcad_bg=$!; ( umask 077; mkdir -p ${quotePosixShell(userDataDir)} ); ` +
    `${liveDaemonShellFunction(host, userDataDir)} ` +
    'orcad_daemon_live; orcad_dl=$?; ' +
    'if [ "$orcad_dl" = 0 ]; then ' +
    `orcad_prev=$(cat ${file}); rm -f ${file}; set -- $orcad_prev; ` +
    `[ "$#" -lt 3 ] || { shift; ( umask 077; echo "$orcad_bg" "$@" > ${file} ); }; ` +
    // Unreadable daemon identity leaves attribution unknown, never assigned to this launch.
    `elif [ "$orcad_dl" = 2 ]; then rm -f ${file}; ` +
    `else rm -f ${file}; [ -z "$orcad_session" ] || ` +
    `( umask 077; echo "$orcad_bg" $orcad_session > ${file} ); fi; :; } 2>/dev/null`
  )
}

export function orcadLaunchSshSessionProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  userDataDir: string
): string {
  const file = recordPath(host, userDataDir)
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  return [
    'orcad_mac=$(sw_vers -productVersion 2>/dev/null) || { echo NOT_APPLICABLE; exit 0; };',
    'orcad_major=${orcad_mac%%.*};',
    'case "$orcad_major" in "" | *[!0-9]*) echo UNVERIFIABLE; exit 0;; esac;',
    `[ "$orcad_major" -ge ${LOCAL_NETWORK_PRIVACY_MAJOR} ] || { echo NOT_APPLICABLE; exit 0; };`,
    `orcad_rec=$(cat ${file} 2>/dev/null) || { echo NOT_RECORDED; exit 0; };`,
    `orcad_pid=$(cat ${pidFile} 2>/dev/null);`,
    'set -- $orcad_rec;',
    'case "$1:$2" in *[!0-9:]* | :* | *:) echo NOT_RECORDED; exit 0;; esac;',
    '[ "$1" = "$orcad_pid" ] || { echo NOT_RECORDED; exit 0; };',
    'orcad_sshd=$2; shift 2; orcad_want=$*;',
    // A ps that can't list this shell can't prove another process absent.
    'ps -o pid= -p "$$" >/dev/null 2>&1 || { echo UNVERIFIABLE; exit 0; };',
    'orcad_now=$(ps -o lstart= -p "$orcad_sshd" 2>/dev/null); orcad_now=$(echo $orcad_now);',
    // A reused PID with another start time is a different process: the session is gone.
    'if [ -z "$orcad_now" ] || [ "$orcad_now" != "$orcad_want" ]; then echo EXITED; else echo LIVE; fi'
  ].join(' ')
}

/** `not-recorded` covers older launches and clients: the condition is unknown, never assumed. */
export type OrcadLaunchSshSession =
  | 'live'
  | 'exited'
  | 'unverifiable'
  | 'not-recorded'
  | 'not-applicable'

export function parseOrcadLaunchSshSession(output: string): OrcadLaunchSshSession {
  switch (output.trim().split('\n').pop()?.trim() ?? '') {
    case 'LIVE':
      return 'live'
    case 'EXITED':
      return 'exited'
    case 'NOT_RECORDED':
      return 'not-recorded'
    case 'NOT_APPLICABLE':
      return 'not-applicable'
    default:
      return 'unverifiable'
  }
}
