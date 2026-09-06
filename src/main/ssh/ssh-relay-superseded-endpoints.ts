/**
 * Relays this target left behind at a *different* version directory.
 *
 * Every relay build installs to `~/.orca-remote/relay-<fullVersion>/` and binds its socket
 * inside it, so the socket path moves on every app update even though the filename component
 * is stable. After an update the new client binds a path the previous relay's PTYs were never
 * associated with, and the previous relay is never contacted again (#13614, #13852). Nothing
 * signals it and nothing reclaims it: with `--grace-time 0` it keeps its shells and agents
 * alive forever.
 *
 * This sweep makes that population *visible and deliberate* rather than silent. It does not
 * make it recoverable — the daemon handshake compares the build's content hash exactly
 * (`relay-handshake.ts`), so a new client cannot speak to an old daemon at all. See the report
 * on this change for what a real cross-version handoff would require.
 *
 * The one thing it will terminate is a relay that provably holds nothing. Everything else is
 * retained, including everything it merely failed to reach.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from './relay-socket-path-limit'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  describeRelayEndpointIncumbent,
  isReapableRelayHusk,
  probeRelayEndpointIncumbent,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { reapEmptyRelayHusk } from './ssh-relay-endpoint-takeover'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/**
 * `reaped` is the only outcome that claims a process ended, and it is only reachable from a
 * post-signal `kill -0` that failed. A signal we sent but could not confirm is
 * `reap-unconfirmed`, which is `unverifiable` — not `exited` by another name.
 */
export type SupersededRelayOutcome =
  | 'reaped'
  | 'reap-unconfirmed'
  | 'retained-live-work'
  | 'stale-endpoint-removed'
  | 'unverifiable'

export type SupersededRelayFinding = {
  sockPath: string
  outcome: SupersededRelayOutcome
  incumbent: RelayEndpointIncumbent
}

export type SupersededRelaySweepOptions = {
  remoteHome: string
  /** Absolute path of the version directory this client just launched into; never swept. */
  currentRelayDir: string
  /** Stable per-target socket filename, from `relaySocketNameForInstanceId`. */
  sockName: string
  /** Set only when this launch relocated its socket; that directory is never swept. */
  currentShortSocketDir?: string
  nodePath: string
  signal?: AbortSignal
}

const MAX_SWEPT_ENDPOINTS = 32

export function supersededRelayEndpointListCommand(options: {
  remoteHome: string
  currentRelayDir: string
  sockName: string
  currentShortSocketDir?: string
}): string {
  return [
    `base=${shellEscape(`${options.remoteHome}/${RELAY_REMOTE_DIR}`)}`,
    `sock_name=${shellEscape(options.sockName)}`,
    `current=${shellEscape(options.currentRelayDir)}`,
    // Why the second base: a host whose `$HOME` pushes the endpoint past `sun_path` binds
    // under `/tmp/.orca-relay-<uid>/relay-<versionHash>/` instead (relay-socket-path-limit.ts).
    // Those orphans are the same population this sweep exists to make visible, and the
    // `$HOME` glob cannot see them. The uid is resolved on the host; the client never knows it.
    `short_current=${shellEscape(options.currentShortSocketDir ?? '')}`,
    `short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`,
    'for sock in "$base"/relay-*/"$sock_name" "$short_base"/relay-*/"$sock_name"; do',
    '  [ -S "$sock" ] || continue',
    '  dir=${sock%/*}',
    '  [ "$dir" = "$current" ] && continue',
    '  [ -n "$short_current" ] && [ "$dir" = "$short_current" ] && continue',
    '  printf \'%s\\n\' "$sock"',
    'done'
  ].join('\n')
}

/** Remove a socket inode proven to have no holder, so version-dir GC can reclaim the tree. */
export function removeStaleRelayEndpointCommand(sockPath: string): string {
  const remove = `rm -f ${shellEscape(sockPath)}`
  if (!sockPath.startsWith(SHORT_RELAY_SOCKET_DIR_PREFIX)) {
    return remove
  }
  // `gcOldRelayVersions` only walks `$HOME/.orca-remote`, so nothing else would ever
  // reclaim a relocated version segment. `rmdir` fails while another target of the same
  // build still has a socket there, which is exactly the condition for keeping it.
  return `${remove}; rmdir ${shellEscape(sockPath.slice(0, sockPath.lastIndexOf('/')))} 2>/dev/null || true`
}

export function classifySupersededRelay(
  incumbent: RelayEndpointIncumbent
): Exclude<SupersededRelayOutcome, 'reaped' | 'reap-unconfirmed'> | 'reap-candidate' {
  if (incumbent.verdict === 'exited') {
    return incumbent.socketPresent ? 'stale-endpoint-removed' : 'unverifiable'
  }
  if (incumbent.verdict !== 'live') {
    return 'unverifiable'
  }
  return isReapableRelayHusk(incumbent) ? 'reap-candidate' : 'retained-live-work'
}

export async function sweepSupersededRelayEndpoints(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  options: SupersededRelaySweepOptions
): Promise<SupersededRelayFinding[]> {
  if (isWindowsRemoteHost(hostPlatform)) {
    return []
  }
  let listing: string
  try {
    listing = await execCommand(conn, supersededRelayEndpointListCommand(options), {
      wrapCommand: true,
      signal: options.signal
    })
  } catch {
    return []
  }
  const sockPaths = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
    .slice(0, MAX_SWEPT_ENDPOINTS)

  const findings: SupersededRelayFinding[] = []
  for (const sockPath of sockPaths) {
    options.signal?.throwIfAborted()
    const incumbent = await probeRelayEndpointIncumbent(
      conn,
      hostPlatform,
      options.nodePath,
      sockPath,
      { signal: options.signal }
    )
    findings.push({
      sockPath,
      outcome: await applySupersededRelayDecision(conn, incumbent, options),
      incumbent
    })
  }
  logSupersededRelayFindings(findings)
  return findings
}

async function applySupersededRelayDecision(
  conn: SshConnection,
  incumbent: RelayEndpointIncumbent,
  options: SupersededRelaySweepOptions
): Promise<SupersededRelayOutcome> {
  const decision = classifySupersededRelay(incumbent)
  if (decision === 'stale-endpoint-removed') {
    try {
      await execCommand(conn, removeStaleRelayEndpointCommand(incumbent.sockPath), {
        wrapCommand: true,
        signal: options.signal
      })
      return 'stale-endpoint-removed'
    } catch {
      return 'unverifiable'
    }
  }
  if (decision !== 'reap-candidate') {
    return decision
  }
  return reapEmptyRelayHusk(conn, incumbent, { signal: options.signal })
}

function logSupersededRelayFindings(findings: SupersededRelayFinding[]): void {
  for (const finding of findings) {
    const detail = describeRelayEndpointIncumbent(finding.incumbent)
    if (finding.outcome === 'retained-live-work') {
      console.warn(
        `[ssh-relay] Superseded relay retained (holds live work; not signalled): ${detail}`
      )
      continue
    }
    if (finding.outcome === 'unverifiable' || finding.outcome === 'reap-unconfirmed') {
      console.warn(`[ssh-relay] Superseded relay ${finding.outcome}: ${detail}`)
      continue
    }
    console.log(`[ssh-relay] Superseded relay ${finding.outcome}: ${detail}`)
  }
}
