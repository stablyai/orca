/**
 * Deciding whether a relay socket path is ours to take, and acting on the answer.
 *
 * Same-path takeover may SIGTERM only a relay proven empty (argv, sole holder, no unaccounted
 * children). The superseded-generation sweep uses a separate command that still re-checks argv
 * but may signal a daemon that still holds PTYs, because that generation is unreachable after
 * an app update. A relay we merely failed to reach is `unverifiable` and never authorized.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import {
  RELAY_UNRECOGNIZED_CHILD_COUNT_VAR,
  relayDaemonChildCensusShell
} from './relay-daemon-service-children'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  describeRelayEndpointIncumbent,
  isReapableRelayHusk,
  mayLaunchOverRelayEndpoint,
  probeRelayEndpointIncumbent,
  RelayEndpointHeldError,
  RelayEndpointUnresponsiveError,
  withHandshakeRefusalEvidence,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { isRelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import { isRelayCredentialMismatchError } from './ssh-relay-credential-mismatch-error'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/** `reaped` is only reachable from a post-signal `kill -0` that failed. Nothing else claims it. */
export type RelayHuskReapResult = 'reaped' | 'reap-unconfirmed' | 'retained-live-work'

const REAP_CONFIRM_ATTEMPTS = 15
// Relay dispose waits up to IMMEDIATE_PTY_EXIT_TIMEOUT_MS (8s) for PTY SIGKILL to land.
const SUPERSEDED_REAP_CONFIRM_ATTEMPTS = 50

function reapRelayDaemonCommand(
  pid: number,
  sockPath: string,
  options?: { requireEmptyUnrecognizedChildren?: boolean; confirmAttempts?: number }
): string {
  const requireEmpty = options?.requireEmptyUnrecognizedChildren !== false
  const confirmAttempts = options?.confirmAttempts ?? REAP_CONFIRM_ATTEMPTS
  return [
    `pid=${shellEscape(String(pid))}`,
    `sock=${shellEscape(sockPath)}`,
    'args=$(ps -o args= -p "$pid" 2>/dev/null | tr "\\n" " ")',
    'case "$args" in *relay.js*"$sock"*) ;; *) printf \'MISMATCH\\n\'; exit 0 ;; esac',
    ...(requireEmpty
      ? [
          // Why the same census as the probe: `unknown` (no pgrep) and any child this host could
          // not account for as a relay service both land on BUSY, so nothing is signalled.
          ...relayDaemonChildCensusShell(),
          `[ "$${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}" = "0" ] || { printf 'BUSY\\n'; exit 0; }`
        ]
      : [
          // Sole-holder was a probe-time fact. Another client can attach before this signal.
          // Why -a: lsof ORs selectors without it and reports unrelated unix-socket holders.
          "command -v lsof >/dev/null 2>&1 || { printf 'BUSY\\n'; exit 0; }",
          'holder_count=$(lsof -t -a -U -- "$sock" 2>/dev/null | sort -u | wc -l | tr -d \' \')',
          '[ "$holder_count" = "1" ] || { printf \'BUSY\\n\'; exit 0; }'
        ]),
    // SIGTERM only: the relay's own handler disposes and unlinks. SIGKILL would leave the
    // socket inode behind and skip that shutdown path for no gain on an empty daemon.
    'kill -TERM "$pid" 2>/dev/null || true',
    'i=0',
    `while [ $i -lt ${confirmAttempts} ]; do`,
    '  kill -0 "$pid" 2>/dev/null || { printf \'GONE\\n\'; exit 0; }',
    '  sleep 0.2',
    '  i=$((i+1))',
    'done',
    "printf 'LIVE\\n'"
  ].join('\n')
}

/**
 * Signal one empty relay, re-verifying identity and emptiness inside the same command.
 *
 * The re-verification is not belt-and-braces: a client can attach and spawn a PTY between the
 * probe and the signal, and pids are reused. `MISMATCH`/`BUSY` abort without signalling.
 */
export function reapEmptyRelayHuskCommand(pid: number, sockPath: string): string {
  return reapRelayDaemonCommand(pid, sockPath)
}

/** SIGTERM a superseded generation even when it still holds PTYs. Argv is still re-checked. */
export function reapSupersededRelayCommand(pid: number, sockPath: string): string {
  return reapRelayDaemonCommand(pid, sockPath, {
    requireEmptyUnrecognizedChildren: false,
    confirmAttempts: SUPERSEDED_REAP_CONFIRM_ATTEMPTS
  })
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

async function signalRelayDaemon(
  conn: SshConnection,
  incumbent: RelayEndpointIncumbent,
  command: string,
  options?: { signal?: AbortSignal }
): Promise<RelayHuskReapResult> {
  const holder = incumbent.holders[0]
  if (!holder) {
    return 'retained-live-work'
  }
  try {
    const output = await execCommand(conn, command, {
      wrapCommand: true,
      signal: options?.signal
    })
    return interpretRelayHuskReapOutput(output)
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return 'reap-unconfirmed'
  }
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
  return signalRelayDaemon(
    conn,
    incumbent,
    reapEmptyRelayHuskCommand(holder.pid, incumbent.sockPath),
    options
  )
}

export async function reapSupersededRelay(
  conn: SshConnection,
  incumbent: RelayEndpointIncumbent,
  options?: { signal?: AbortSignal }
): Promise<RelayHuskReapResult> {
  const holder = incumbent.holders[0]
  if (!holder) {
    return 'retained-live-work'
  }
  return signalRelayDaemon(
    conn,
    incumbent,
    reapSupersededRelayCommand(holder.pid, incumbent.sockPath),
    options
  )
}

/**
 * Called when `--connect` to an existing socket failed and the caller is about to launch a
 * replacement at the same path. Resolves when the launch may proceed; throws
 * `RelayEndpointHeldError` when a live relay refused us and holds work, and
 * `RelayEndpointUnresponsiveError` when a live relay holds work but never answered — the
 * second is retryable, because silence is not a decision.
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
  // A refused credential is the same positive evidence: the daemon answered.
  const refused =
    isRelayVersionMismatchError(reconnectError) || isRelayCredentialMismatchError(reconnectError)
  const incumbent = refused ? withHandshakeRefusalEvidence(probed) : probed
  console.warn(`[ssh-relay] Relay endpoint incumbent: ${describeRelayEndpointIncumbent(incumbent)}`)

  if (mayLaunchOverRelayEndpoint(incumbent)) {
    return incumbent
  }
  if (!isReapableRelayHusk(incumbent)) {
    throw refused
      ? new RelayEndpointHeldError(incumbent)
      : new RelayEndpointUnresponsiveError(incumbent)
  }
  const result = await reapEmptyRelayHusk(conn, incumbent, options)
  if (result !== 'reaped') {
    throw refused
      ? new RelayEndpointHeldError(incumbent)
      : new RelayEndpointUnresponsiveError(incumbent)
  }
  console.log(`[ssh-relay] Reaped empty relay husk holding ${sockPath}`)
  return incumbent
}
