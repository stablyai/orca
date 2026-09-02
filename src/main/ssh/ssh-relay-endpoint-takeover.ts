/**
 * Deciding whether a relay socket path is ours to take, and acting on the answer.
 *
 * The only destructive action available here is a SIGTERM to a relay that has been proven —
 * by argv, by socket-holder enumeration, and by a zero child count re-checked on the host
 * immediately before the signal — to hold nothing at all. Everything else is left running.
 * Per docs/reference/ssh-execution-boundary.md, a relay we merely failed to reach is
 * `unverifiable`, and `unverifiable` never authorizes a kill or a rebind.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  describeRelayEndpointIncumbent,
  isReapableRelayHusk,
  mayLaunchOverRelayEndpoint,
  probeRelayEndpointIncumbent,
  RelayEndpointHeldError,
  withHandshakeRefusalEvidence,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { isRelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/** `reaped` is only reachable from a post-signal `kill -0` that failed. Nothing else claims it. */
export type RelayHuskReapResult = 'reaped' | 'reap-unconfirmed' | 'retained-live-work'

const REAP_CONFIRM_ATTEMPTS = 15

/**
 * Signal one relay, re-verifying identity and emptiness inside the same command.
 *
 * The re-verification is not belt-and-braces: a client can attach and spawn a PTY between the
 * probe and the signal, and pids are reused. `MISMATCH`/`BUSY` abort without signalling.
 */
export function reapEmptyRelayHuskCommand(pid: number, sockPath: string): string {
  return [
    `pid=${shellEscape(String(pid))}`,
    `sock=${shellEscape(sockPath)}`,
    'args=$(ps -o args= -p "$pid" 2>/dev/null | tr "\\n" " ")',
    'case "$args" in *relay.js*"$sock"*) ;; *) printf \'MISMATCH\\n\'; exit 0 ;; esac',
    "command -v pgrep >/dev/null 2>&1 || { printf 'BUSY\\n'; exit 0; }",
    'kids=$(pgrep -P "$pid" 2>/dev/null | grep -c .)',
    '[ "$kids" = "0" ] || { printf \'BUSY\\n\'; exit 0; }',
    // SIGTERM only: the relay's own handler disposes and unlinks. SIGKILL would leave the
    // socket inode behind and skip that shutdown path for no gain on an empty daemon.
    'kill -TERM "$pid" 2>/dev/null || true',
    'i=0',
    `while [ $i -lt ${REAP_CONFIRM_ATTEMPTS} ]; do`,
    '  kill -0 "$pid" 2>/dev/null || { printf \'GONE\\n\'; exit 0; }',
    '  sleep 0.2',
    '  i=$((i+1))',
    'done',
    "printf 'LIVE\\n'"
  ].join('\n')
}

export function interpretRelayHuskReapOutput(output: string): RelayHuskReapResult {
  const state = output.trim().split('\n').pop()?.trim()
  if (state === 'GONE') {
    return 'reaped'
  }
  // The host refused on its own re-check: what is there is not the empty relay we probed, so
  // nothing was signalled and nothing is claimed about it.
  if (state === 'MISMATCH' || state === 'BUSY') {
    return 'retained-live-work'
  }
  return 'reap-unconfirmed'
}

export async function reapEmptyRelayHusk(
  conn: SshConnection,
  incumbent: RelayEndpointIncumbent,
  options?: { signal?: AbortSignal }
): Promise<RelayHuskReapResult> {
  const holder = incumbent.holders[0]
  if (!holder) {
    return 'retained-live-work'
  }
  try {
    const output = await execCommand(
      conn,
      reapEmptyRelayHuskCommand(holder.pid, incumbent.sockPath),
      { wrapCommand: true, signal: options?.signal }
    )
    return interpretRelayHuskReapOutput(output)
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return 'reap-unconfirmed'
  }
}

/**
 * Called when `--connect` to an existing socket failed and the caller is about to launch a
 * replacement at the same path. Resolves to nothing when the launch may proceed; throws
 * `RelayEndpointHeldError` when a live relay owns the path and holds work.
 *
 * `unverifiable` deliberately permits the launch: the daemon, not the client, performs the
 * takeover. `RelaySocketOwnership.listen` re-probes on EADDRINUSE, refuses a path that accepts
 * connections, and only unlinks an inode whose identity is unchanged — a check that is atomic
 * with the bind, which a client-side `rm -f` can never be.
 */
export async function resolveRelayEndpointBeforeRelaunch(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  sockPath: string,
  reconnectError: unknown,
  options?: { signal?: AbortSignal }
): Promise<RelayEndpointIncumbent> {
  const probed = await probeRelayEndpointIncumbent(conn, hostPlatform, nodePath, sockPath, options)
  // A daemon that answered the handshake with its own version is live by positive host
  // evidence, even where nothing can enumerate socket holders.
  const incumbent = isRelayVersionMismatchError(reconnectError)
    ? withHandshakeRefusalEvidence(probed)
    : probed
  console.warn(`[ssh-relay] Relay endpoint incumbent: ${describeRelayEndpointIncumbent(incumbent)}`)

  if (mayLaunchOverRelayEndpoint(incumbent)) {
    return incumbent
  }
  if (!isReapableRelayHusk(incumbent)) {
    throw new RelayEndpointHeldError(incumbent)
  }
  const result = await reapEmptyRelayHusk(conn, incumbent, options)
  if (result !== 'reaped') {
    throw new RelayEndpointHeldError(incumbent)
  }
  console.log(`[ssh-relay] Reaped empty relay husk holding ${sockPath}`)
  return incumbent
}
