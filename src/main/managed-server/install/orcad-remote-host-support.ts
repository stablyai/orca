// Windows operations use the host script; only POSIX command builders use this guard.
import {
  isWindowsRemoteHost,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'

export class OrcadRemoteLaunchUnsupportedError extends Error {
  readonly code = 'orcad_remote_launch_unsupported_host'
  constructor(hostLabel: string) {
    super(
      `This orcad command does not run on a ${hostLabel} host. The install transaction is ` +
        'host-agnostic, but this step is a POSIX command with a separate Windows path.'
    )
    this.name = 'OrcadRemoteLaunchUnsupportedError'
  }
}

export function assertPosixOrcadHost(host: RemoteHostPlatform): void {
  if (isWindowsRemoteHost(host)) {
    throw new OrcadRemoteLaunchUnsupportedError('Windows')
  }
}

/** Candidate stdout containing readiness; bounded below even if other output follows. */
export const ORCAD_READINESS_FILENAME = '.orcad-readiness'
export const ORCAD_LOG_FILENAME = 'orcad.log'
// Candidate stdout is untrusted in size; never read runaway output whole.
export const ORCAD_READINESS_MAX_BYTES = 256 * 1024

export const ORCAD_PID_FILENAME = '.orcad-pid'
/** Pair the PID with boot ID and node name; shared home paths cannot identify a machine. */
export const ORCAD_PID_MACHINE_FILENAME = `${ORCAD_PID_FILENAME}-machine`
/** Emit nothing without a boot ID; launch and later wait compare this identity. */
export const ORCAD_LAUNCH_MACHINE_COMMAND = 'cat /proc/sys/kernel/random/boot_id&&uname -n'

/** Windows pairs PID with creation time because PID reuse alone cannot identify the process. */
export const ORCAD_WINDOWS_PROCESS_FILENAME = '.orcad-process.json'

/** ESRCH text: bash, dash and BusyBox print "No such process"; zsh and ksh print it lowercase (#34149). */
export const POSIX_NO_SUCH_PROCESS_CASE = '*[Nn]"o such process"*'

/** kill -0 includes zombies; ps excludes them, while missing evidence conservatively retains the process. */
export function posixProcessAliveShellFunction(
  options: { refuseUnverifiable?: boolean } = {}
): string {
  // Destructive lifecycle steps need explicit absence; permission failures cannot prove exit.
  const probe = options.refuseUnverifiable
    ? 'probe_error=$(LC_ALL=C kill -0 "$1" 2>&1) || { ' +
      `case "$probe_error" in ${POSIX_NO_SUCH_PROCESS_CASE}) return 1;; ` +
      '*) echo UNKNOWN; exit 0;; esac; }; '
    : 'kill -0 "$1" 2>/dev/null || return 1; '
  return (
    `orcad_alive() { ${probe}` +
    'orcad_stat=$(ps -o stat= -p "$1" 2>/dev/null) && [ -n "$orcad_stat" ] || ' +
    // Field 3 of /proc/<pid>/stat follows the last ")": comm itself may hold spaces or parens.
    'orcad_stat=$(cat "/proc/$1/stat" 2>/dev/null) && orcad_stat=${orcad_stat##*") "}; ' +
    'case "$orcad_stat" in Z*) return 1;; esac; return 0; };'
  )
}

/** Prints a PID's argv; slim Linux images ship no ps, so fall back to /proc (#34149). */
export function posixProcessArgsShellFunction(): string {
  return (
    'orcad_args() { orcad_argv=$(ps -o args= -p "$1" 2>/dev/null) && [ -n "$orcad_argv" ] || ' +
    '{ orcad_argv=$(tr "\\000" " " 2>/dev/null < "/proc/$1/cmdline") || return 1; ' +
    // Kernel threads and zombies have no argv; their stat line still names them.
    '[ -n "$orcad_argv" ] || orcad_argv=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; }; ' +
    'printf "%s\\n" "$orcad_argv"; };'
  )
}

/**
 * `orcad_slot_busy LAUNCHER SERVER` returns 0 when a process other than this probe's shells has
 * argv naming either entry, 1 when none does, 2 when processes cannot be listed. Matching argv,
 * not a PID, means PID reuse cannot fake a live slot or hide one that is starting (#51014).
 */
export function posixSlotProcessScanShellFunction(): string {
  // The glob expands before this shell forks any reader, so only $$ and $PPID can be the probe.
  const viaProc =
    'for orcad_sp in /proc/[0-9]*; do orcad_sp=${orcad_sp#/proc/}; ' +
    '{ [ "$orcad_sp" = "$$" ] || [ "$orcad_sp" = "$PPID" ]; } && continue; ' +
    'orcad_sa=$(tr "\\000" " " 2>/dev/null < "/proc/$orcad_sp/cmdline") || continue; ' +
    'case "$orcad_sa" in *"$1"* | *"$2"*) return 0;; esac; done; return 1;'
  // A subshell that has not exec'd ps yet carries this shell's argv, so skip this shell's children.
  const viaPs =
    'orcad_sl=$(ps -A -ww -o pid= -o ppid= -o args= 2>/dev/null) && [ -n "$orcad_sl" ] || return 2; ' +
    'printf "%s\\n" "$orcad_sl" | { while read -r orcad_sp orcad_spp orcad_sa; do ' +
    '{ [ "$orcad_sp" = "$$" ] || [ "$orcad_sp" = "$PPID" ] || [ "$orcad_spp" = "$$" ]; } && continue; ' +
    'case "$orcad_sa" in *"$1"* | *"$2"*) exit 0;; esac; done; exit 1; };'
  return `orcad_slot_busy() { if [ -r /proc/self/cmdline ]; then ${viaProc} fi; ${viaPs} };`
}
