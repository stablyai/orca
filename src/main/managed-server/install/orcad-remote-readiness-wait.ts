// Wait on-host in one bounded exec; repeated SSH polling spawned process bursts and triggered Windows EDR.
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  ORCAD_PID_FILENAME,
  ORCAD_PID_MACHINE_FILENAME,
  ORCAD_READINESS_FILENAME,
  ORCAD_READINESS_MAX_BYTES,
  ORCAD_LAUNCH_MACHINE_COMMAND
} from './orcad-remote-host-support'
import {
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_READINESS_MARKER } from '../host-state/orcad-windows-host-script'

// Stay below the 30-second exec timeout so waits can answer before channel expiry.
export const ORCAD_READINESS_WAIT_MAX_SECONDS = 20

const ORCAD_LAUNCH_EXITED_MARKER = 'ORCAD_LAUNCH_EXITED'

function posixReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const file = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  const read = `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${file} 2>/dev/null`
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  const pidMachine = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, ORCAD_PID_MACHINE_FILENAME)
  )
  return [
    // Fail early only on proven exit from the launching machine; shared homes and unverified PIDs must keep waiting.
    `orcad_launch_here() { orcad_recorded=$(cat ${pidMachine} 2>/dev/null) && [ -n "$orcad_recorded" ] && [ "$orcad_recorded" = "$(${ORCAD_LAUNCH_MACHINE_COMMAND} 2>/dev/null)" ]; };`,
    `orcad_launch_exited() { orcad_launch_here || return 1; pid=$(cat ${pidFile} 2>/dev/null); case "$pid" in "" | *[!0-9]*) return 1;; esac;`,
    'probe_error=$(LC_ALL=C kill -0 "$pid" 2>&1) || { case "$probe_error" in *"No such process"*) return 0;; esac; return 1; };',
    'case "$(ps -o stat= -p "$pid" 2>/dev/null)" in Z*) return 0;; esac; return 1; };',
    // Probe fractional sleep once; POSIX hosts may support only integer seconds.
    'if sleep 0.25 2>/dev/null; then orcad_readiness_wait_step=0.25;',
    'else orcad_readiness_wait_step=1; fi;',
    // Bound elapsed time, not iterations: slow filesystem reads otherwise overrun the client exec deadline.
    `orcad_readiness_wait_end=$(($(date +%s) + ${waitSeconds}));`,
    'while [ "$(date +%s)" -lt "$orcad_readiness_wait_end" ]; do',
    `[ "$(${read} | wc -l)" -gt 0 ] && break;`,
    `[ "$(${read} | wc -c)" -gt ${ORCAD_READINESS_MAX_BYTES} ] && break;`,
    `orcad_launch_exited && { echo ${ORCAD_LAUNCH_EXITED_MARKER}; break; };`,
    'sleep "$orcad_readiness_wait_step"; done;',
    `${read} || true`
  ].join(' ')
}

export function orcadReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const seconds = Math.max(0, Math.min(ORCAD_READINESS_WAIT_MAX_SECONDS, Math.ceil(waitSeconds)))
  if (!isWindowsRemoteHost(host)) {
    return posixReadinessWaitCommand(host, remoteInstallDir, seconds)
  }
  return orcadWindowsSlotOpCommand(host, remoteInstallDir, 'readiness-wait', [
    joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME),
    String(ORCAD_READINESS_MAX_BYTES),
    String(seconds)
  ])
}

export function parseOrcadReadinessWaitOutput(
  host: RemoteHostPlatform,
  output: string
): OrcadReadinessParse {
  return parseOrcadReadinessOutput(
    isWindowsRemoteHost(host)
      ? (readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_READINESS_MARKER) ?? '')
      : withoutLaunchExitedMarker(output)
  )
}

export function orcadLaunchExitedDuringWait(host: RemoteHostPlatform, output: string): boolean {
  return !isWindowsRemoteHost(host) && output.startsWith(`${ORCAD_LAUNCH_EXITED_MARKER}\n`)
}

function withoutLaunchExitedMarker(output: string): string {
  return output.startsWith(`${ORCAD_LAUNCH_EXITED_MARKER}\n`)
    ? output.slice(ORCAD_LAUNCH_EXITED_MARKER.length + 1)
    : output
}

export function readOrcadReadinessNowCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  // Windows host wait with zero delay substitutes for the unavailable head command.
  return isWindowsRemoteHost(host)
    ? orcadReadinessWaitCommand(host, remoteInstallDir, 0)
    : readOrcadReadinessCommand(host, remoteInstallDir)
}
