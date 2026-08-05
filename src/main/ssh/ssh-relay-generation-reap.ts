// Recovery for a POSIX relay socket whose reconnect failed.
//
// The old behaviour was `rm -f <socket>` followed by a fresh detached launch, which strands the
// process that still owns the socket — and with it every PTY it holds (#8585). This module instead
// proves ownership from the generation manifest and argv marker, sends one SIGTERM to that exact
// generation, waits for its identity to disappear, and only then removes artifacts that still
// belong to it. Every step that cannot be proven fails closed: no signal, no unlink, no relaunch.
//
// Threat boundary: the manifest and socket live in a directory owned by the SSH user, and a same-OS
// user can already signal that user's processes directly. The guarantees here are against accidents
// — PID reuse, a successor generation, a half-written or stale manifest — not against an attacker
// who already has the account.

import { isRelayNamedPipeEndpoint } from '../../shared/relay-owner-manifest'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  parseRelayGenerationCleanupOutput,
  parseRelayGenerationIdentityOutput,
  parseRelayGenerationTerminateOutput,
  parseRelayOwnerProbeOutput,
  relayGenerationCleanupCommand,
  relayGenerationIdentityCommand,
  relayGenerationTerminateCommand,
  relayOwnerProbeCommand
} from './ssh-relay-generation-owner-commands'
import { waitForRelayPollDelay } from './ssh-relay-poll-delay'
import { acquireRelayRecoveryLock, releaseRelayRecoveryLock } from './ssh-relay-recovery-lock'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

// Why: the relay's own SIGTERM path disposes PTYs in parallel but waits IMMEDIATE_PTY_EXIT_TIMEOUT_MS
// (8s) plus a 250ms force-kill retry for the slowest one (src/relay/pty-handler.ts). Giving up sooner
// would destroy the user's PTYs and then still refuse to relaunch. A relay that outlives even this
// (a pending PTY creation has no timeout of its own) yields a retryable `still-running`, not a
// terminal one, so the next reconnect attempt can observe the eventual exit.
const RELAY_GENERATION_EXIT_INTERVAL_MS = 500
export const RELAY_GENERATION_EXIT_MAX_ATTEMPTS = 30
export const RELAY_GENERATION_EXIT_BUDGET_MS =
  RELAY_GENERATION_EXIT_INTERVAL_MS * RELAY_GENERATION_EXIT_MAX_ATTEMPTS
// Why: these probes are single `stat`/`ps` reads, so the 30s execCommand default is far too generous
// — it would let one wedged command stretch the recovery past the lock's staleness window.
const RELAY_GENERATION_EXEC_TIMEOUT_MS = 15_000

export type RelayGenerationRecoveryReason =
  | 'recovery-busy'
  | 'owner-unknown'
  | 'owner-unverifiable'
  | 'probe-failed'
  | 'identity-mismatch'
  | 'identity-unverifiable'
  | 'termination-failed'
  | 'still-running'
  | 'cleanup-blocked'

const RECOVERY_ADVICE: Record<RelayGenerationRecoveryReason, string> = {
  'recovery-busy': 'another Orca client is already recovering this relay; retry shortly',
  'owner-unknown':
    'it was launched by an older Orca that publishes no owner manifest, so the process holding it cannot be identified',
  'owner-unverifiable': 'its owner manifest could not be read and trusted',
  'probe-failed': 'the remote host did not answer the ownership probe',
  'identity-mismatch': 'the recorded process is no longer that relay generation',
  'identity-unverifiable': 'the recorded process state could not be determined',
  'termination-failed': 'the termination request could not be confirmed',
  'still-running': 'the relay did not exit after SIGTERM',
  'cleanup-blocked': 'a newer relay generation already owns the socket'
}

// Why: the message must not claim the relay is untouched once a SIGTERM has already landed.
const SIGNALLED_REASONS = new Set<RelayGenerationRecoveryReason>([
  'still-running',
  'cleanup-blocked'
])

export class RelayGenerationRecoveryError extends Error {
  readonly reason: RelayGenerationRecoveryReason
  readonly sockPath: string

  constructor(reason: RelayGenerationRecoveryReason, sockPath: string, cause?: unknown) {
    const aftermath = SIGNALLED_REASONS.has(reason)
      ? 'Orca did not remove the socket or start a replacement.'
      : 'Orca left the existing relay and its PTYs untouched.'
    super(
      `Refusing to reclaim the relay socket at ${sockPath}: ${RECOVERY_ADVICE[reason]}. ${aftermath} Reset the relay for this host from SSH settings, or wait for the idle relay grace period to drain it.`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'RelayGenerationRecoveryError'
    this.reason = reason
    this.sockPath = sockPath
  }
}

// Why: only a refusal that re-running cannot change belongs here. A transport fault, a peer holding
// the lock, a relay still draining, or a successor that already took the socket are all states the
// existing reconnect backoff resolves — treating them as terminal would park a healthy session on
// one timed-out probe.
const TERMINAL_RECOVERY_REASONS = new Set<RelayGenerationRecoveryReason>([
  'owner-unknown',
  'owner-unverifiable',
  'identity-mismatch'
])

/**
 * True for a recovery refusal no amount of reconnect backoff can resolve, so the session layer can
 * surface the message instead of looping.
 */
export function isTerminalRelayGenerationRecoveryError(
  error: unknown
): error is RelayGenerationRecoveryError {
  return (
    error instanceof RelayGenerationRecoveryError && TERMINAL_RECOVERY_REASONS.has(error.reason)
  )
}

export type RelayReconnectRecovery<T> =
  | { status: 'reconnected'; value: T }
  | { status: 'relaunched'; value: T }
  | { status: 'unsupported' }

export type RelayReconnectRecoveryOptions<T> = {
  sockPath: string
  signal?: AbortSignal
  /** Retried once under the recovery lock — a peer may have already replaced the relay. */
  reconnect: () => Promise<T>
  /** Runs inside the recovery lock so two clients cannot both launch a fresh relay. */
  relaunch: () => Promise<T>
}

export async function recoverFailedRelayReconnect<T>(
  conn: SshConnection,
  host: RemoteHostPlatform,
  options: RelayReconnectRecoveryOptions<T>
): Promise<RelayReconnectRecovery<T>> {
  const { sockPath, signal } = options
  if (isWindowsRemoteHost(host) || isRelayNamedPipeEndpoint(sockPath)) {
    return { status: 'unsupported' }
  }
  const lock = await acquireRelayRecoveryLock(conn, host, sockPath, signal).catch(
    (err: unknown) => {
      if (isUnconfirmedSshCommandTermination(err)) {
        throw err
      }
      signal?.throwIfAborted()
      throw new RelayGenerationRecoveryError('recovery-busy', sockPath, err)
    }
  )
  if (lock === null) {
    throw new RelayGenerationRecoveryError('recovery-busy', sockPath)
  }
  try {
    signal?.throwIfAborted()
    // Why: only a caller that queued behind a peer can find the socket already recovered. An
    // uncontended acquire proves nothing changed, so retrying the reconnect would just pay the
    // sentinel timeout twice.
    if (lock.waited) {
      const reconnected = await reconnectIfSocketRecovered(conn, host, options)
      if (reconnected !== null) {
        return { status: 'reconnected', value: reconnected }
      }
    }
    await reapRelayGeneration(conn, host, sockPath, signal)
    signal?.throwIfAborted()
    return { status: 'relaunched', value: await options.relaunch() }
  } finally {
    // Why: deliberately not the caller's signal — an abort is exactly when the lock most needs
    // removing, and passing an aborted signal would make execCommand refuse and leak it until the
    // staleness window expires.
    await releaseRelayRecoveryLock(conn, host, sockPath, lock.token)
  }
}

/** Returns the reconnected transport when a peer already recovered this socket, else null. */
async function reconnectIfSocketRecovered<T>(
  conn: SshConnection,
  host: RemoteHostPlatform,
  options: RelayReconnectRecoveryOptions<T>
): Promise<T | null> {
  const { sockPath, signal } = options
  const probe = await exec(
    conn,
    host,
    `test -S ${shellEscape(sockPath)} && echo ALIVE || echo DEAD`,
    sockPath,
    'probe-failed',
    signal
  )
  signal?.throwIfAborted()
  if (probe.trim() !== 'ALIVE') {
    return null
  }
  try {
    return await options.reconnect()
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    return null
  }
}

async function reapRelayGeneration(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  signal?: AbortSignal
): Promise<void> {
  const probe = parseRelayOwnerProbeOutput(
    await exec(conn, host, relayOwnerProbeCommand(sockPath), sockPath, 'probe-failed', signal),
    sockPath
  )
  signal?.throwIfAborted()
  if (probe.kind === 'socket-absent') {
    // Nothing left to reclaim — the owner already released the path.
    return
  }
  if (probe.kind === 'no-manifest') {
    throw new RelayGenerationRecoveryError('owner-unknown', sockPath)
  }
  if (probe.kind !== 'owned') {
    throw new RelayGenerationRecoveryError('owner-unverifiable', sockPath)
  }
  const { manifest, socketIdentity } = probe
  const identityCommand = relayGenerationIdentityCommand(manifest.pid, manifest.generation)
  const identity = parseRelayGenerationIdentityOutput(
    await exec(conn, host, identityCommand, sockPath, 'identity-unverifiable', signal)
  )
  signal?.throwIfAborted()
  if (identity.kind === 'mismatch') {
    throw new RelayGenerationRecoveryError('identity-mismatch', sockPath)
  }
  if (identity.kind === 'indeterminate') {
    throw new RelayGenerationRecoveryError('identity-unverifiable', sockPath)
  }
  if (identity.kind === 'match') {
    await terminateGeneration(
      conn,
      host,
      sockPath,
      manifest.pid,
      manifest.generation,
      identity.startToken,
      signal
    )
    await waitForGenerationExit(conn, host, sockPath, identityCommand, signal)
  }
  const cleanup = parseRelayGenerationCleanupOutput(
    await exec(
      conn,
      host,
      relayGenerationCleanupCommand(sockPath, socketIdentity, manifest.generation),
      sockPath,
      'cleanup-blocked',
      signal
    )
  )
  signal?.throwIfAborted()
  if (cleanup !== 'clean') {
    throw new RelayGenerationRecoveryError('cleanup-blocked', sockPath)
  }
}

async function terminateGeneration(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  pid: number,
  generation: string,
  startToken: string,
  signal?: AbortSignal
): Promise<void> {
  // Why: the command re-reads argv and the start token and only then signals, so the window between
  // proof and SIGTERM is one remote command rather than one SSH round trip.
  const command = relayGenerationTerminateCommand(pid, generation, startToken)
  const output = await exec(conn, host, command, sockPath, 'termination-failed', signal)
  signal?.throwIfAborted()
  const result = parseRelayGenerationTerminateOutput(output)
  if (result === 'signalled' || result === 'gone') {
    return
  }
  if (result === 'mismatch') {
    throw new RelayGenerationRecoveryError('identity-mismatch', sockPath)
  }
  throw new RelayGenerationRecoveryError('termination-failed', sockPath)
}

async function waitForGenerationExit(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  identityCommand: string,
  signal?: AbortSignal
): Promise<void> {
  for (let attempt = 0; attempt < RELAY_GENERATION_EXIT_MAX_ATTEMPTS; attempt++) {
    await waitForRelayPollDelay(RELAY_GENERATION_EXIT_INTERVAL_MS, signal)
    signal?.throwIfAborted()
    const identity = parseRelayGenerationIdentityOutput(
      await exec(conn, host, identityCommand, sockPath, 'still-running', signal)
    )
    signal?.throwIfAborted()
    if (identity.kind === 'gone' || identity.kind === 'mismatch') {
      return
    }
  }
  throw new RelayGenerationRecoveryError('still-running', sockPath)
}

/**
 * Runs one recovery probe. Anything that is not an unconfirmed SSH termination becomes a typed
 * failure, so no caller can mistake a transport fault for permission to unlink and relaunch.
 */
async function exec(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  sockPath: string,
  reason: RelayGenerationRecoveryReason,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await execCommand(conn, command, {
      wrapCommand: !isWindowsRemoteHost(host),
      timeoutMs: RELAY_GENERATION_EXEC_TIMEOUT_MS,
      signal
    })
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    throw new RelayGenerationRecoveryError(reason, sockPath, err)
  }
}
