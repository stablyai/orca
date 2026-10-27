// Redirect detached candidate stdout to its version directory so readiness does not hold SSH open.
import type { OrcadLaunchEnvEntry } from '../../ssh/orcad-host-transport'
import {
  ORCAD_LAUNCHER_FILENAME,
  ORCAD_SERVER_ENTRY_FILENAME
} from '../../../shared/orcad-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  remoteDirname,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { ORCAD_WSL_HOST_ENV } from '../../ipc/wsl-guest-windows-drive-path'
import {
  assertPosixOrcadHost as assertPosixHost,
  ORCAD_LOG_FILENAME,
  ORCAD_PID_FILENAME,
  ORCAD_LAUNCH_MACHINE_COMMAND,
  ORCAD_PID_MACHINE_FILENAME,
  ORCAD_READINESS_FILENAME,
  ORCAD_READINESS_MAX_BYTES,
  posixProcessAliveShellFunction
} from './orcad-remote-host-support'
import type { ServeReadiness } from '../../server/serve-readiness'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../../shared/orcad-stop-request'
import { orcadWindowsSlotOpCommand } from './orcad-remote-windows-node'
import {
  captureOrcadLaunchSshSessionCommand,
  recordsOrcadLaunchSshSession,
  writeOrcadLaunchSshSessionCommand
} from '../../ssh/orcad-launch-ssh-session'
import {
  ORCAD_E2E_IDLE_TIMEOUT_ENV,
  readOrcadE2EIdleTimeoutMs
} from '../../../shared/orcad-idle-exit'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/orcad-managed-launch-env'

export type OrcadLaunchSpec = {
  remoteInstallDir: string
  nodePath: string
  fullVersion: string
  /** Shared across versions; rollback requires a snapshot. */
  userDataDir: string
  bindHost: string
  port: number
  /** Shared activation fence; managed SSH launches may idle out. */
  activationRoot: string
}

/** Older orcad versions ignore these launch variables. */
export function orcadManagedLaunchEnv(
  spec: OrcadLaunchSpec,
  env: NodeJS.ProcessEnv = process.env
): [string, string][] {
  const e2eTimeout = readOrcadE2EIdleTimeoutMs(env)
  return [
    [ORCAD_MANAGED_ACTIVATION_ROOT_ENV, spec.activationRoot],
    ...(e2eTimeout === null
      ? []
      : [[ORCAD_E2E_IDLE_TIMEOUT_ENV, String(e2eTimeout)] satisfies [string, string]])
  ]
}

/** WSL without systemd kills nohup children with wsl.exe --exec; use a separate session. */
export type OrcadLaunchDetach = 'nohup' | 'setsid'

const ORCAD_SETSID_PID_WAIT_TRIES = 100

/** Halving V8's 16 MB semi-spaces saves ~30 MB idle RSS; a CLI flag because the heap cannot be resized later. */
export const ORCAD_RUNTIME_V8_FLAGS = '--max-semi-space-size=8'

/** Pass bind explicitly so launch policy cannot change with installed-version defaults. */
export function orcadLaunchCommand(
  host: RemoteHostPlatform,
  spec: OrcadLaunchSpec,
  detach: OrcadLaunchDetach = 'nohup',
  hostEnv: readonly OrcadLaunchEnvEntry[] = []
): string {
  assertPosixHost(host)
  const dir = quotePosixShell(spec.remoteInstallDir)
  // Relative artifact paths reduce command size; every use follows the same-shell cd.
  const readiness = quotePosixShell(ORCAD_READINESS_FILENAME)
  const log = quotePosixShell(ORCAD_LOG_FILENAME)
  // PID writes run outside nohup’s backgrounded cd; reuse one absolute path to stay within command budgets.
  const pidFile = '"$orcad_pid"'
  // Liveness matches runtime argv against the absolute entry path.
  const entry = quotePosixShell(
    joinRemotePath(host, spec.remoteInstallDir, ORCAD_LAUNCHER_FILENAME)
  )
  const baseDir = remoteDirname(spec.remoteInstallDir.replace(/\/+$/u, ''), host)
  // Tighten only the managed root, never an unrelated custom-slot parent.
  const privateDirs = [
    ...(remoteBasename(baseDir, host) === RELAY_REMOTE_DIR ? [baseDir] : []),
    spec.remoteInstallDir
  ]
  // Capture in the launching shell; detached subshell variables do not return here.
  const recordSession = detach === 'nohup' && recordsOrcadLaunchSshSession(host)
  const launchEnv = [
    `ORCA_VERSION=${quotePosixShell(spec.fullVersion)}`,
    `ORCA_USER_DATA=${quotePosixShell(spec.userDataDir)}`,
    ...orcadManagedLaunchEnv(spec).map(([name, value]) => `${name}=${quotePosixShell(value)}`)
  ]
  return [
    `orcad_pid=${quotePosixShell(joinRemotePath(host, spec.remoteInstallDir, ORCAD_PID_FILENAME))};`,
    // Record the launching machine before detaching; absent boot identity leaves it unverified.
    `{ ${ORCAD_LAUNCH_MACHINE_COMMAND};}>"$orcad_pid${ORCAD_PID_MACHINE_FILENAME.slice(ORCAD_PID_FILENAME.length)}" 2>/dev/null;`,
    ...(recordSession ? [captureOrcadLaunchSshSessionCommand()] : []),
    // Preserve login umask for daemon children creating user files.
    'orcad_login_umask=$(umask);',
    // Pairing-token artifacts need umask 077 from creation; semicolon also covers the external PID write.
    'umask 077;',
    // Tighten existing artifacts best-effort; umask cannot repair their modes.
    `{ chmod 700 ${privateDirs.map(quotePosixShell).join(' ')} 2>/dev/null || :; } &&`,
    `cd ${dir} &&`,
    `${selectOrcadSlotRuntimeCommand(host, spec.remoteInstallDir, spec.nodePath)} &&`,
    // Truncate so relaunch cannot activate on the previous process’s readiness.
    `: > ${readiness} &&`,
    // Required: truncating redirects retain old file modes.
    `chmod 600 ${readiness} &&`,
    `{ chmod 600 ${pidFile} ${log} 2>/dev/null || :; } &&`,
    `rm -f ${quotePosixShell(ORCAD_STOP_REQUEST_FILENAME)} &&`,
    ...(detach === 'setsid' ? [`rm -f ${pidFile} &&`] : []),
    ...(detach === 'setsid'
      ? setsidLaunchTail(entry, spec, readiness, log, pidFile, launchEnv, hostEnv)
      : [
          // Open redirects under 077 before restoring daemon login umask.
          '{ umask "$orcad_login_umask" &&',
          ...launchEnv,
          // exec keeps $! equal to runtime PID; in-place launcher loading also preserves older clients’ argv checks.
          `exec nohup "$orcad_runtime" ${ORCAD_RUNTIME_V8_FLAGS} ${entry}`,
          `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)};`,
          `} > ${readiness} 2>> ${log} < /dev/null &`,
          `echo $! > ${pidFile} &&`,
          ...(recordSession
            ? [`${writeOrcadLaunchSshSessionCommand(host, spec.userDataDir)} &&`]
            : []),
          `cat ${pidFile}`
        ])
  ].join(' ')
}

/** setsid -f exits its parent, so the exec child records $$; BusyBox uses background setsid without -f. */
function setsidLaunchTail(
  entry: string,
  spec: OrcadLaunchSpec,
  readiness: string,
  log: string,
  pidFile: string,
  launchEnv: readonly string[],
  hostEnv: readonly OrcadLaunchEnvEntry[]
): string[] {
  return [
    ...launchEnv,
    // Only WSL setsid launches receive this marker.
    `${ORCAD_WSL_HOST_ENV}=1`,
    ...hostEnv.map(launchEnvAssignment),
    'sh -c \'orcad_detach() { if setsid -f true >/dev/null 2>&1; then setsid -f "$@"; ' +
      'else setsid "$@" & fi; }; orcad_detach "$@"\' orcad-detach',
    `sh -c 'echo $$ > "$1" && umask "$2" && shift 2 && exec "$@"' orcad-launch ${pidFile}`,
    '"$orcad_login_umask"',
    `"$orcad_runtime" ${ORCAD_RUNTIME_V8_FLAGS} ${entry}`,
    `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)}`,
    `> ${readiness} 2>> ${log} < /dev/null &&`,
    `orcad_wait=0; while [ ! -s ${pidFile} ] && [ "$orcad_wait" -lt ${ORCAD_SETSID_PID_WAIT_TRIES} ];`,
    'do sleep 0.05; orcad_wait=$((orcad_wait + 1)); done;',
    `cat ${pidFile}`
  ]
}

function launchEnvAssignment([name, value, mode]: OrcadLaunchEnvEntry): string {
  if (mode !== 'keep-existing') {
    return `${assertEnvName(name)}=${quotePosixShell(value)}`
  }
  // Inside "${NAME:-default}" quotes are literal, so only quote-free defaults are expressible.
  if (!/^[A-Za-z0-9._=:,/-]+$/.test(value)) {
    throw new Error(`orcad_launch_env_default_invalid:${name}`)
  }
  return `${assertEnvName(name)}="\${${name}:-${value}}"`
}

function assertEnvName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`orcad_launch_env_name_invalid:${name}`)
  }
  return name
}

export function readOrcadReadinessCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  assertPosixHost(host)
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME)
  )
  return `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${readiness} 2>/dev/null || true`
}

/** LIVE/DEAD/UNKNOWN distinguish proven state from missing/denied identity probes.
 * No PID or readiness file means NEVER_LAUNCHED, which also proves this slot has no process. */
export function orcadLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return orcadWindowsSlotOpCommand(host, remoteInstallDir, 'liveness', [remoteInstallDir])
  }
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME)
  )
  const launcher = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_LAUNCHER_FILENAME))
  const server = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, ORCAD_SERVER_ENTRY_FILENAME)
  )
  return [
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    // PID reuse needs argv identity; absent ps leaves conservative liveness checks to decide.
    `orcad_launcher=${launcher}; orcad_server=${server};`,
    // The probe's own shell, or the shell wrapping it, carries the slot paths in its argv; after a
    // restart either can hold the old PID. A shell elsewhere may be an older launcher's live parent.
    'orcad_reused() { { [ "$1" = "$$" ] || [ "$1" = "$PPID" ]; } && return 0; ' +
      'args=$(ps -o args= -p "$1" 2>/dev/null) && [ -n "$args" ] && ' +
      'case "$args" in *"$orcad_launcher"* | *"$orcad_server"*) return 1;; *) return 0;; esac; };',
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in',
    `"" ) if [ -e ${pidFile} ] || [ -e ${readiness} ]; then echo UNKNOWN; else echo ${ORCAD_NEVER_LAUNCHED}; fi;;`,
    '*[!0-9]* ) echo UNKNOWN;;',
    '* ) if orcad_reused "$pid"; then echo DEAD; elif orcad_alive "$pid"; then echo LIVE; else echo DEAD; fi;;',
    'esac'
  ].join(' ')
}

export const ORCAD_NEVER_LAUNCHED = 'NEVER_LAUNCHED'

export type OrcadLiveness = 'LIVE' | 'DEAD' | 'UNKNOWN' | typeof ORCAD_NEVER_LAUNCHED

export function parseOrcadLiveness(output: string): OrcadLiveness {
  const value = output.trim().split('\n').pop()?.trim()
  return value === 'LIVE' || value === 'DEAD' || value === ORCAD_NEVER_LAUNCHED ? value : 'UNKNOWN'
}

/** Only DEAD/NEVER_LAUNCHED permit lifecycle changes; UNKNOWN proves nothing. */
export function orcadLivenessProvenExited(liveness: OrcadLiveness): boolean {
  return liveness === 'DEAD' || liveness === ORCAD_NEVER_LAUNCHED
}

export function orcadLivenessAnswerBlocksGc(output: string): boolean {
  return orcadLivenessBlocksGc(parseOrcadLiveness(output))
}

export function orcadLivenessBlocksGc(liveness: OrcadLiveness): boolean {
  return !orcadLivenessProvenExited(liveness)
}

export type OrcadReadinessParse =
  | { state: 'ready'; readiness: ServeReadiness }
  | { state: 'pending' }
  | { state: 'malformed'; reason: string }

/** Treat an unfinished last line as pending; polling can race a candidate stdout append. */
export function parseOrcadReadinessOutput(raw: string): OrcadReadinessParse {
  if (Buffer.byteLength(raw, 'utf8') > ORCAD_READINESS_MAX_BYTES) {
    return { state: 'malformed', reason: 'readiness payload exceeds the 256 KiB limit' }
  }
  const lines = raw.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Only an unterminated last line can recover from a partial write.
      return index === lines.length - 1
        ? { state: 'pending' }
        : { state: 'malformed', reason: 'readiness line is not valid JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue
    }
    const payload = parsed as { type?: unknown }
    if (payload.type !== 'orca_server_ready') {
      return {
        state: 'malformed',
        reason: `expected an orca_server_ready line, got type=${JSON.stringify(payload.type)}`
      }
    }
    return { state: 'ready', readiness: toServeReadiness(payload as Record<string, unknown>) }
  }
  return { state: 'pending' }
}

function toServeReadiness(payload: Record<string, unknown>): ServeReadiness {
  return {
    runtimeId: typeof payload.runtimeId === 'string' ? payload.runtimeId : '',
    boundEndpoint: typeof payload.boundEndpoint === 'string' ? payload.boundEndpoint : null,
    advertisedEndpoint:
      typeof payload.advertisedEndpoint === 'string' ? payload.advertisedEndpoint : null,
    managedWslCliReconciliation:
      payload.managedWslCliReconciliation === 'pending' ||
      payload.managedWslCliReconciliation === 'failed'
        ? payload.managedWslCliReconciliation
        : 'settled',
    pairing: payload.pairing as ServeReadiness['pairing'],
    ...(payload.health ? { health: payload.health as ServeReadiness['health'] } : {})
  }
}
