/**
 * Stopping a running orcad on the host without taking its terminals with it.
 *
 * SIGTERM starts one bounded durable shutdown. If it outlasts this wait, preserve the
 * current owner; SIGKILL would skip flushing state and releasing the instance lock.
 */
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_READINESS_FILENAME } from './orcad-remote-launch'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import {
  assertPosixOrcadHost as assertPosixHost,
  ORCAD_PID_FILENAME,
  posixProcessAliveShellFunction
} from './orcad-remote-host-support'

/**
 * Signal the orcad recorded in a version dir and wait for it to go.
 *
 * `justLaunched` is only for this client's fixed exec launcher, including pre-readiness exits.
 * Incumbents need their own readiness PID to corroborate the launcher's PID before any signal.
 */
export function stopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  options: { waitSeconds: number } & (
    | { justLaunched: true }
    | { justLaunched?: false; nodePath: string }
  )
): string {
  assertPosixHost(host)
  const pidFile = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  const readiness = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  const readRuntimePid = [
    `const r = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));`,
    `const pid = r?.type === 'orca_server_ready' ? r.health?.pid : null;`,
    `if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(1);`,
    `process.stdout.write(String(pid));`
  ].join(' ')
  return [
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in "" | *[!0-9]* ) echo NO_PID; exit 0;; esac;',
    // Older launchers recorded a waiting shell, whose exit does not prove runtime exit.
    ...(options.justLaunched
      ? []
      : [
          `runtime_pid=$(${selectOrcadSlotRuntimeCommand(host, remoteInstallDir, options.nodePath)}; ` +
            `"$orcad_runtime" -e ${shellEscape(readRuntimePid)} ${readiness} 2>/dev/null) || { echo UNKNOWN; exit 0; };`,
          '[ "$pid" = "$runtime_pid" ] || { echo UNKNOWN; exit 0; };'
        ]),
    'orcad_alive "$pid" || { echo ALREADY_EXITED; exit 0; };',
    'kill -TERM "$pid" 2>/dev/null || { echo SIGNAL_FAILED; exit 0; };',
    `i=0; while [ "$i" -lt ${options.waitSeconds} ]; do`,
    'orcad_alive "$pid" || { echo STOPPED; exit 0; };',
    'sleep 1; i=$((i + 1)); done;',
    'echo STILL_RUNNING'
  ].join(' ')
}

export type OrcadStopOutcome =
  | 'stopped'
  | 'already-exited'
  | 'no-pid'
  | 'still-running'
  | 'signal-failed'
  | 'unknown'

export function parseOrcadStopOutcome(output: string): OrcadStopOutcome {
  switch (output.trim().split('\n').pop()?.trim() ?? '') {
    case 'STOPPED':
      return 'stopped'
    case 'ALREADY_EXITED':
      return 'already-exited'
    case 'NO_PID':
      return 'no-pid'
    case 'STILL_RUNNING':
      return 'still-running'
    case 'SIGNAL_FAILED':
      return 'signal-failed'
    default:
      return 'unknown'
  }
}

/** True when the port is free and a successor may bind. */
export function orcadStopFreedTheHost(outcome: OrcadStopOutcome): boolean {
  return outcome === 'stopped' || outcome === 'already-exited'
}
