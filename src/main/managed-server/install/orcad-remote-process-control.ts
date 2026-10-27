// SIGKILL skips durable shutdown and instance-lock release; preserve owners that outlast the stop wait.
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  ORCAD_READINESS_FILENAME,
  ORCAD_PID_FILENAME,
  posixProcessAliveShellFunction
} from './orcad-remote-host-support'
import {
  ORCAD_STOP_REQUEST_FILENAME,
  ORCAD_STOP_REQUESTS_CAPABILITY
} from '../../../shared/orcad-stop-request'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import { orcadWindowsSlotOpCommand } from './orcad-remote-windows-node'

/** Corroborate the readiness PID before stopping; justLaunched also covers pre-readiness exits. */
export function stopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  options: { waitSeconds: number } & (
    | { justLaunched: true }
    | { justLaunched?: false; nodePath: string }
  )
): string {
  if (isWindowsRemoteHost(host)) {
    // Windows termination skips durable shutdown; use the stop-request file.
    return orcadWindowsSlotOpCommand(host, remoteInstallDir, 'stop', [
      remoteInstallDir,
      String(options.waitSeconds),
      options.justLaunched === true ? '1' : '0'
    ])
  }
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME)
  )
  const requestFile = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, ORCAD_STOP_REQUEST_FILENAME)
  )
  const readRuntimePid = [
    `const r = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));`,
    `const pid = r?.type === 'orca_server_ready' ? r.health?.pid : null;`,
    `if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(1);`,
    `const mode = r.health?.stopRequests === ${ORCAD_STOP_REQUESTS_CAPABILITY} ? 'request' : 'signal';`,
    `process.stdout.write(String(pid) + ':' + mode);`
  ].join(' ')
  return [
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in "" | *[!0-9]* ) echo NO_PID; exit 0;; esac;',
    'stop_mode=signal;',
    // Older launchers recorded a waiting shell, whose exit does not prove runtime exit.
    ...(options.justLaunched
      ? []
      : [
          `runtime_answer=$(${selectOrcadSlotRuntimeCommand(host, remoteInstallDir, options.nodePath)}; ` +
            `"$orcad_runtime" -e ${quotePosixShell(readRuntimePid)} ${readiness} 2>/dev/null) || { echo UNKNOWN; exit 0; };`,
          '[ "$pid" = "${runtime_answer%%:*}" ] || { echo UNKNOWN; exit 0; };',
          'stop_mode=${runtime_answer#*:};'
        ]),
    'orcad_alive "$pid" || { echo ALREADY_EXITED; exit 0; };',
    'if [ "$stop_mode" = request ]; then',
    `( umask 077; : > ${requestFile} ) 2>/dev/null || { echo SIGNAL_FAILED; exit 0; };`,
    'else kill -TERM "$pid" 2>/dev/null || { echo SIGNAL_FAILED; exit 0; }; fi;',
    // Past here the stop may be under way, so a lost or unknown answer must keep the fence.
    'echo SIGNALED;',
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
  /** Windows build lacks graceful stop support. */
  | 'unsupported'
  /** Proven unknown before sending a stop. */
  | 'unknown'
  /** A stop may have been sent; the host may still be changing. */
  | 'unconfirmed'

export function parseOrcadStopOutcome(output: string): OrcadStopOutcome {
  const lines = output
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
  const last = lines.at(-1) ?? ''
  if (last === 'UNKNOWN' && !lines.includes('SIGNALED')) {
    return 'unknown'
  }
  switch (last) {
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
    case 'UNSUPPORTED':
      return 'unsupported'
    default:
      return 'unconfirmed'
  }
}

export function orcadStopFreedTheHost(outcome: OrcadStopOutcome): boolean {
  return outcome === 'stopped' || outcome === 'already-exited'
}
