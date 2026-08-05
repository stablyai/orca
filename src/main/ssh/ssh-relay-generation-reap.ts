// Recovery for a POSIX relay socket whose reconnect failed.
//
// The old behaviour was `rm -f <socket>` followed by a fresh detached launch, which strands the
// process that still owns the socket — and with it every PTY it holds (#8585). This module instead
// proves ownership from the generation manifest and argv marker, sends one SIGTERM to that exact
// generation, waits for its identity to disappear, and then relaunches only once the socket
// pathname is proven empty. It removes nothing: after the owner exits no identity can authorize an
// unlink, because a successor binding the same path within one second reproduces dev:ino:ctime
// exactly. Every step that cannot be proven fails closed: no signal, no unlink, no relaunch.
//
// Ownership has to be proven by the first read. Once any read finds the path unowned, this attempt
// is over: a later `owned` read is a relay that finished publishing while we watched — a successor
// completing startup — and killing that is #8585 aimed at a healthy relay. The next reconnect picks
// it up through the normal backoff.
//
// Threat boundary: the manifest and socket live in a directory owned by the SSH user, and a same-OS
// user can already signal that user's processes directly. The guarantees here are against accidents
// — PID reuse, a successor generation, a half-written or stale manifest — not against an attacker
// who already has the account.

import { isRelayNamedPipeEndpoint } from '../../shared/relay-owner-manifest'
import {
  RelayGenerationRecoveryError,
  type RelayGenerationRecoveryReason
} from './ssh-relay-generation-recovery-error'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  parseRelayGenerationIdentityOutput,
  parseRelayGenerationTerminateOutput,
  parseRelayOwnerProbeOutput,
  parseRelayRelaunchReadinessOutput,
  relayGenerationIdentityCommand,
  relayGenerationTerminateCommand,
  relayOwnerProbeCommand,
  relayRelaunchReadinessCommand,
  type RelayOwnerProbe
} from './ssh-relay-generation-owner-commands'
import { waitForRelayPollDelay } from './ssh-relay-poll-delay'
import { acquireRelayRecoveryLock, releaseRelayRecoveryLock } from './ssh-relay-recovery-lock'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export {
  RelayGenerationRecoveryError,
  isTerminalRelayGenerationRecoveryError,
  type RelayGenerationRecoveryReason
} from './ssh-relay-generation-recovery-error'

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
  const probe = await probeOwner(conn, host, sockPath, signal)
  if (probe.kind === 'socket-absent') {
    // Why the readiness proof anyway: the probe reports an absent socket for a path it merely could
    // not read. Only the readiness command proves the parent is searchable before calling it empty.
    await proveRelaunchReadiness(conn, host, sockPath, signal)
    return
  }
  if (probe.kind !== 'owned') {
    throw new RelayGenerationRecoveryError(probeRefusalReason(probe), sockPath)
  }
  const { manifest } = probe
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
  // Why: a readiness proof, not a cleanup. Once the owner is gone nothing can authorize an unlink —
  // a successor binding the same path within one second reproduces dev:ino:ctime exactly — so the
  // parent removes nothing and relaunches only over an empty pathname.
  await proveRelaunchReadiness(conn, host, sockPath, signal)
}

async function proveRelaunchReadiness(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  signal?: AbortSignal
): Promise<void> {
  const readiness = parseRelayRelaunchReadinessOutput(
    await exec(
      conn,
      host,
      relayRelaunchReadinessCommand(sockPath),
      sockPath,
      'relaunch-blocked',
      signal
    )
  )
  signal?.throwIfAborted()
  if (readiness !== 'absent') {
    throw new RelayGenerationRecoveryError('relaunch-blocked', sockPath)
  }
}

/** The probe kinds that describe a path this client does not own — and cannot classify in one read. */
type TransitionalProbe = Extract<RelayOwnerProbe, { kind: 'no-manifest' | 'manifest-superseded' }>

/** A settled probe, or the one verdict no single read can produce: ownership moved while observed. */
type RelayOwnerObservation = RelayOwnerProbe | { kind: 'owner-in-transition' }

// Why these two: `no-manifest` cannot tell a legacy relay from a successor between listen and
// publication, and `manifest-superseded` cannot tell a live rebind from a stale manifest a legacy
// relay inherited. Each covers one terminal state and one transient one.
function isTransitionalProbe(probe: RelayOwnerProbe): probe is TransitionalProbe {
  return probe.kind === 'no-manifest' || probe.kind === 'manifest-superseded'
}

/**
 * Reads the owner probe, re-reading once when the first read cannot be classified on its own.
 *
 * Why the second read never grants permission: it happens only because the first read found the path
 * unowned, so an `owned` second read means a relay finished publishing while this attempt watched —
 * a successor completing startup, not a generation to reclaim. Signalling that is #8585 aimed at a
 * healthy relay. Anything that moved between the reads yields `owner-in-transition`, which the
 * reconnect backoff retries; the healthy relay is picked up by the next reconnect, not by this reap.
 */
async function probeOwner(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  signal?: AbortSignal
): Promise<RelayOwnerObservation> {
  const command = relayOwnerProbeCommand(sockPath)
  const first = parseRelayOwnerProbeOutput(
    await exec(conn, host, command, sockPath, 'probe-failed', signal),
    sockPath
  )
  signal?.throwIfAborted()
  if (!isTransitionalProbe(first)) {
    return first
  }
  await waitForRelayPollDelay(RELAY_GENERATION_EXIT_INTERVAL_MS, signal)
  signal?.throwIfAborted()
  const second = parseRelayOwnerProbeOutput(
    await exec(conn, host, command, sockPath, 'probe-failed', signal),
    sockPath
  )
  signal?.throwIfAborted()
  return settleTransitionalProbe(first, second)
}

function settleTransitionalProbe(
  first: TransitionalProbe,
  second: RelayOwnerProbe
): RelayOwnerObservation {
  if (second.kind === 'owned') {
    return { kind: 'owner-in-transition' }
  }
  // Why pass the rest through: an absent socket still has to clear the readiness proof, and every
  // other kind is already its own fail-closed refusal. Neither can be made worse by a first read.
  if (!isTransitionalProbe(second)) {
    return second
  }
  // Why the kind counts as movement too: a manifest that appeared or vanished at an unchanging
  // socket is a publication or a shutdown in progress, which is no more settled than a rebind.
  if (second.kind !== first.kind || second.socketIdentity !== first.socketIdentity) {
    return { kind: 'owner-in-transition' }
  }
  // Why escalate: two identical reads mean nothing is moving, so a manifest that still fails to
  // describe this socket is stale rather than transient — most likely a legacy relay that inherited
  // a dead generation's file. Retrying that forever would hide it behind backoff.
  return second.kind === 'manifest-superseded' ? { kind: 'manifest-malformed' } : second
}

function probeRefusalReason(probe: RelayOwnerObservation): RelayGenerationRecoveryReason {
  switch (probe.kind) {
    case 'no-manifest':
      return 'owner-unknown'
    case 'manifest-rejected':
    case 'manifest-malformed':
    case 'manifest-foreign':
      return 'owner-unverifiable'
    // Why grouped: the two-read gate settles every superseded read, so that arm is here for
    // exhaustiveness. Both say ownership moved, never that this client may reclaim it.
    case 'manifest-superseded':
    case 'owner-in-transition':
      return 'owner-in-transition'
    case 'socket-unusable':
      return 'endpoint-unusable'
    case 'socket-unreadable':
    case 'indeterminate':
      return 'owner-indeterminate'
    // Why listed rather than defaulted: the caller handles both before reaching here, and an
    // exhaustive switch makes a future probe kind fail to compile instead of silently inheriting a
    // classification nobody chose.
    case 'owned':
    case 'socket-absent':
      return 'owner-indeterminate'
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
