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
import { shellEscape } from './ssh-connection-utils'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  remoteDirname,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  assertPosixOrcadHost as assertPosixHost,
  ORCAD_LOG_FILENAME,
  ORCAD_PID_FILENAME,
  ORCAD_READINESS_FILENAME,
  ORCAD_READINESS_MAX_BYTES,
  posixProcessAliveShellFunction
} from './orcad-remote-host-support'
import type { ServeReadiness } from '../server/serve-readiness'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { windowsOrcadLivenessProbeCommand } from './orcad-remote-liveness-windows'
import {
  ORCAD_E2E_IDLE_TIMEOUT_ENV,
  ORCAD_MANAGED_ACTIVATION_ROOT_ENV,
  readOrcadE2EIdleTimeoutMs
} from '../../shared/orcad-idle-exit'

export {
  ORCAD_LOG_FILENAME,
  ORCAD_PID_FILENAME,
  ORCAD_READINESS_FILENAME,
  ORCAD_READINESS_MAX_BYTES,
  OrcadRemoteLaunchUnsupportedError
} from './orcad-remote-host-support'

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
 * Launch the candidate detached and echo its PID.
 *
 * Why `--bind` is always passed explicitly: orcad defaults to loopback, but a default is a
 * thing a future version can change. The deploy states the posture it intends rather than
 * inheriting whatever the installed build happens to default to.
 */
export function orcadLaunchCommand(host: RemoteHostPlatform, spec: OrcadLaunchSpec): string {
  assertPosixHost(host)
  const dir = shellEscape(spec.remoteInstallDir)
  const readiness = shellEscape(
    joinRemotePath(host, spec.remoteInstallDir, ORCAD_READINESS_FILENAME)
  )
  const log = shellEscape(joinRemotePath(host, spec.remoteInstallDir, ORCAD_LOG_FILENAME))
  const pidFile = shellEscape(joinRemotePath(host, spec.remoteInstallDir, ORCAD_PID_FILENAME))
  const entry = shellEscape(joinRemotePath(host, spec.remoteInstallDir, 'orcad.js'))
  const baseDir = remoteDirname(spec.remoteInstallDir.replace(/\/+$/u, ''), host)
  // Only `~/.orca-remote` itself; never tighten an unrelated parent a custom slot path names.
  const privateDirs = [
    ...(remoteBasename(baseDir, host) === RELAY_REMOTE_DIR ? [baseDir] : []),
    spec.remoteInstallDir
  ]
  return [
    // Why first: the readiness file carries the pairing offer's device token, so every file this
    // launch creates must be owner-only from birth, not only the ones after the exec.
    'umask 077 &&',
    // Best effort: directories and files an earlier build left 0755/0644 keep their old modes.
    `{ chmod 700 ${privateDirs.map(shellEscape).join(' ')} 2>/dev/null || :; } &&`,
    `cd ${dir} &&`,
    `${selectOrcadSlotRuntimeCommand(host, spec.remoteInstallDir, spec.nodePath)} &&`,
    // Why truncate: a re-launch into a dir that already holds a previous readiness line would
    // otherwise let the deploy activate on the OLD process's health payload.
    `: > ${readiness} &&`,
    // Required, not best effort: a truncating redirect keeps an earlier build's 0644 mode.
    `chmod 600 ${readiness} &&`,
    `{ chmod 600 ${pidFile} ${log} 2>/dev/null || :; } &&`,
    // A stop request the previous process never consumed must not stop this one.
    `rm -f ${shellEscape(joinRemotePath(host, spec.remoteInstallDir, ORCAD_STOP_REQUEST_FILENAME))} &&`,
    `ORCA_VERSION=${shellEscape(spec.fullVersion)}`,
    `ORCA_USER_DATA=${shellEscape(spec.userDataDir)}`,
    ...orcadManagedLaunchEnv(spec).map(([name, value]) => `${name}=${shellEscape(value)}`),
    // Keep $! equal to the runtime PID rather than a waiting shell's PID.
    `exec nohup "$orcad_runtime" ${entry}`,
    `--json --bind ${shellEscape(spec.bindHost)} --port ${String(spec.port)}`,
    `> ${readiness} 2>> ${log} < /dev/null &`,
    `echo $! > ${pidFile} && cat ${pidFile}`
  ].join(' ')
}

export function readOrcadReadinessCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  assertPosixHost(host)
  const readiness = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
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
 * `NEVER_LAUNCHED`, which only GC reads apart from `UNKNOWN`.
 */
export function orcadLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return windowsOrcadLivenessProbeCommand(host, remoteInstallDir)
  }
  const pidFile = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  const readiness = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  const entry = shellEscape(joinRemotePath(host, remoteInstallDir, 'orcad.js'))
  return [
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    // A PID is no identity once reused: a process whose command line does not run this slot's
    // orcad.js is not it. No `ps` answer leaves the plain liveness check to decide.
    `orcad_entry=${entry};`,
    'orcad_reused() { args=$(ps -o args= -p "$1" 2>/dev/null) && [ -n "$args" ] && ' +
      'case "$args" in *"$orcad_entry"*) return 1;; *) return 0;; esac; };',
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in',
    `"" ) if [ -e ${pidFile} ] || [ -e ${readiness} ]; then echo UNKNOWN; else echo ${ORCAD_NEVER_LAUNCHED}; fi;;`,
    '*[!0-9]* ) echo UNKNOWN;;',
    '* ) if orcad_reused "$pid"; then echo DEAD; elif orcad_alive "$pid"; then echo LIVE; else echo DEAD; fi;;',
    'esac'
  ].join(' ')
}

export type OrcadLiveness = 'LIVE' | 'DEAD' | 'UNKNOWN'

export function parseOrcadLiveness(output: string): OrcadLiveness {
  const value = output.trim().split('\n').pop()?.trim()
  return value === 'LIVE' || value === 'DEAD' ? value : 'UNKNOWN'
}

export const ORCAD_NEVER_LAUNCHED = 'NEVER_LAUNCHED'

/** GC's reading of a liveness answer: a slot that never launched holds nothing and is removable. */
export function orcadLivenessAnswerBlocksGc(output: string): boolean {
  return output.trim().split('\n').pop()?.trim() === ORCAD_NEVER_LAUNCHED
    ? false
    : orcadLivenessBlocksGc(parseOrcadLiveness(output))
}

/** True when GC must leave this directory alone. Inconclusive counts as in use. */
export function orcadLivenessBlocksGc(liveness: OrcadLiveness): boolean {
  return liveness !== 'DEAD'
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
