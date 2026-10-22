/**
 * Starting a candidate orcad on the host and reading back what it says about itself.
 *
 * This is the piece `docs/design/shipping-orcad.html` §02 marks **fork**, not reuse: the
 * relay launches detached and proves itself by printing an `ORCA-RELAY` sentinel, and orcad
 * has no such interface. It publishes a single `orca_server_ready` JSON line on stdout,
 * carrying the health payload activation is gated on — so the handshake here is "capture
 * that line", not "match a marker".
 *
 * The candidate is launched detached with stdout redirected to a file inside its own version
 * directory. Reading readiness off the exec channel would mean holding the channel open for
 * the process's whole life; redirecting means the deploy can disconnect and the supervisor
 * still owns a running service.
 */
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
  /** Shared across versions, and the reason rollback needs a snapshot. */
  userDataDir: string
  /** Loopback by default; the client reaches it through an SSH local port-forward. */
  bindHost: string
  port: number
  /** The host's activation fence. Every SSH launch is client-managed, so every one may idle out. */
  activationRoot: string
}

/** Env a managed launch adds; an older orcad ignores both. */
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

/**
 * How the candidate leaves the exec's session. `nohup … &` dies with its `wsl.exe --exec` session
 * on a distro without systemd, so a WSL slot starts in a session of its own.
 */
export type OrcadLaunchDetach = 'nohup' | 'setsid'

const ORCAD_SETSID_PID_WAIT_TRIES = 100

/**
 * Launch the candidate detached and echo its PID.
 *
 * Why `--bind` is always passed explicitly: orcad defaults to loopback, but a default is a
 * thing a future version can change. The deploy states the posture it intends rather than
 * inheriting whatever the installed build happens to default to.
 */
export function orcadLaunchCommand(
  host: RemoteHostPlatform,
  spec: OrcadLaunchSpec,
  detach: OrcadLaunchDetach = 'nohup',
  hostEnv: readonly OrcadLaunchEnvEntry[] = []
): string {
  assertPosixHost(host)
  const dir = quotePosixShell(spec.remoteInstallDir)
  // Relative to the `cd` below, which every use follows in the same shell: the slot path is most
  // of the sent bytes.
  const readiness = quotePosixShell(ORCAD_READINESS_FILENAME)
  const log = quotePosixShell(ORCAD_LOG_FILENAME)
  // Absolute: a nohup launch backgrounds the whole list, `cd` included, then writes this outside it.
  const pidFile = quotePosixShell(joinRemotePath(host, spec.remoteInstallDir, ORCAD_PID_FILENAME))
  // Absolute: liveness matches the runtime's args against this path.
  const entry = quotePosixShell(
    joinRemotePath(host, spec.remoteInstallDir, ORCAD_LAUNCHER_FILENAME)
  )
  const baseDir = remoteDirname(spec.remoteInstallDir.replace(/\/+$/u, ''), host)
  // Only `~/.orca-remote` itself; never tighten an unrelated parent a custom slot path names.
  const privateDirs = [
    ...(remoteBasename(baseDir, host) === RELAY_REMOTE_DIR ? [baseDir] : []),
    spec.remoteInstallDir
  ]
  // Why in the launching shell: the detached list below runs in a subshell whose variables are lost.
  const recordSession = detach === 'nohup' && recordsOrcadLaunchSshSession(host)
  const launchEnv = [
    `ORCA_VERSION=${quotePosixShell(spec.fullVersion)}`,
    `ORCA_USER_DATA=${quotePosixShell(spec.userDataDir)}`,
    ...orcadManagedLaunchEnv(spec).map(([name, value]) => `${name}=${quotePosixShell(value)}`)
  ]
  return [
    ...(recordSession ? [captureOrcadLaunchSshSessionCommand()] : []),
    // The daemon gets this back: the git, terminals and agents it spawns create the user's files.
    'orcad_login_umask=$(umask);',
    // Why before anything is created: the readiness file carries the pairing offer's device token,
    // so every file this launch creates must be owner-only from birth. Why `;`: a nohup launch
    // backgrounds the `&&` list below, and the PID file is written outside it.
    'umask 077;',
    // Best effort: directories and files an earlier build left 0755/0644 keep their old modes.
    `{ chmod 700 ${privateDirs.map(quotePosixShell).join(' ')} 2>/dev/null || :; } &&`,
    `cd ${dir} &&`,
    `${selectOrcadSlotRuntimeCommand(host, spec.remoteInstallDir, spec.nodePath)} &&`,
    // Why truncate: a re-launch into a dir that already holds a previous readiness line would
    // otherwise let the deploy activate on the OLD process's health payload.
    `: > ${readiness} &&`,
    // Required, not best effort: a truncating redirect keeps an earlier build's 0644 mode.
    `chmod 600 ${readiness} &&`,
    `{ chmod 600 ${pidFile} ${log} 2>/dev/null || :; } &&`,
    // A stop request the previous process never consumed must not stop this one.
    `rm -f ${quotePosixShell(ORCAD_STOP_REQUEST_FILENAME)} &&`,
    ...(detach === 'setsid' ? [`rm -f ${pidFile} &&`] : []),
    ...(detach === 'setsid'
      ? setsidLaunchTail(entry, spec, readiness, log, pidFile, launchEnv, hostEnv)
      : [
          // Why a group: its redirects open under 077 before the daemon gets the login umask back.
          '{ umask "$orcad_login_umask" &&',
          ...launchEnv,
          // Keep $! equal to the runtime PID rather than a waiting shell's PID.
          // Older clients identify the live PID by orcad.js; the pinned launcher loads the body in-place.
          `exec nohup "$orcad_runtime" ${entry}`,
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

/**
 * The forked child records its own PID (`$$` survives its exec into the runtime) because the
 * `setsid -f` parent exits at once. busybox `setsid` has no `-f`; backgrounding it is equivalent
 * there because a background child of a non-interactive shell never leads a process group.
 */
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
    // Only a setsid (WSL host) launch marks itself; SSH keeps its byte-for-byte command.
    `${ORCAD_WSL_HOST_ENV}=1`,
    ...hostEnv.map(([name, value]) => `${assertEnvName(name)}=${quotePosixShell(value)}`),
    'sh -c \'orcad_detach() { if setsid -f true >/dev/null 2>&1; then setsid -f "$@"; ' +
      'else setsid "$@" & fi; }; orcad_detach "$@"\' orcad-detach',
    // The PID file is written under 077 before the daemon gets the login umask back.
    `sh -c 'echo $$ > "$1" && umask "$2" && shift 2 && exec "$@"' orcad-launch ${pidFile}`,
    '"$orcad_login_umask"',
    `"$orcad_runtime" ${entry}`,
    `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)}`,
    `> ${readiness} 2>> ${log} < /dev/null &&`,
    `orcad_wait=0; while [ ! -s ${pidFile} ] && [ "$orcad_wait" -lt ${ORCAD_SETSID_PID_WAIT_TRIES} ];`,
    'do sleep 0.05; orcad_wait=$((orcad_wait + 1)); done;',
    `cat ${pidFile}`
  ]
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
  // One byte over the cap is enough to tell an oversized payload from a full one.
  return `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${readiness} 2>/dev/null || true`
}

/**
 * Is the process recorded in this version dir still running?
 *
 * Answers `LIVE`, `DEAD`, or `UNKNOWN`. `UNKNOWN` covers a missing or unparseable PID file
 * and a `kill -0` that failed for a reason other than "no such process" — a permission
 * error means someone else's process holds that PID, which is evidence of neither. A slot with
 * neither a PID file nor a readiness file (which a launch creates first) answers
 * `NEVER_LAUNCHED`: nothing was ever started from it, so like `DEAD` it is proven exit.
 */
export function orcadLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    // Windows: PID plus process creation time (PIDs are reused); anything unanswerable is UNKNOWN, never DEAD.
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
    // A PID is no identity once reused: a process whose command line does not run this slot's
    // entry is not it. No `ps` answer leaves the plain liveness check to decide.
    `orcad_launcher=${launcher}; orcad_server=${server};`,
    'orcad_reused() { args=$(ps -o args= -p "$1" 2>/dev/null) && [ -n "$args" ] && ' +
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

/** The probe's last line; anything but a known word is `UNKNOWN`, never a guess. */
export function parseOrcadLiveness(output: string): OrcadLiveness {
  const value = output.trim().split('\n').pop()?.trim()
  return value === 'LIVE' || value === 'DEAD' || value === ORCAD_NEVER_LAUNCHED ? value : 'UNKNOWN'
}

/**
 * Proven exit: a dead PID, or a slot nothing was ever started from. `UNKNOWN` proves nothing,
 * so a reader that would start, replace or remove must not act on it.
 */
export function orcadLivenessProvenExited(liveness: OrcadLiveness): boolean {
  return liveness === 'DEAD' || liveness === ORCAD_NEVER_LAUNCHED
}

/** GC's reading of a liveness answer: a slot that never launched holds nothing and is removable. */
export function orcadLivenessAnswerBlocksGc(output: string): boolean {
  return orcadLivenessBlocksGc(parseOrcadLiveness(output))
}

/** True when GC must leave this directory alone. Inconclusive counts as in use. */
export function orcadLivenessBlocksGc(liveness: OrcadLiveness): boolean {
  return !orcadLivenessProvenExited(liveness)
}

export type OrcadReadinessParse =
  | { state: 'ready'; readiness: ServeReadiness }
  | { state: 'pending' }
  | { state: 'malformed'; reason: string }

/**
 * Pull the `orca_server_ready` payload out of whatever the candidate has written so far.
 *
 * Why scan for the type tag rather than parsing the last line: stdout is a file being
 * appended to, so a poll can catch a half-written line. A partial JSON line is `pending`,
 * not `malformed` — reporting a parse failure for a race would fail deploys that were fine.
 */
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
      // Only the unterminated last line can still be mid-write; a finished bad line will stay bad.
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
