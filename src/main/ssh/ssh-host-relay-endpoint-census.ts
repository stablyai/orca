/**
 * Whether any Orca relay on an SSH host still runs work, asked over the bootstrap connection
 * before a relay session exists. Local leases only cover this desktop's terminals; the host's own
 * relay endpoints also show terminals another desktop opened there.
 *
 * Loss of contact is never evidence of exit (docs/reference/ssh-execution-boundary.md): a listing
 * that failed, ran out of room, or an endpoint the probe could not classify is `unverifiable`.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from './relay-socket-path-limit'
import { execCommand } from './ssh-relay-deploy-helpers'
import { probeRelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { classifySupersededRelay } from './ssh-relay-superseded-endpoints'
import { countRelayEndpointPtys } from './ssh-relay-endpoint-pty-count'
import { readRelayDaemonRuntimes } from './ssh-relay-endpoint-runtime'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/** `unenumerable`: Windows named pipes cannot be listed, so the caller keeps today's path. */
export type HostRelayEndpointVerdict = 'none' | 'idle' | 'live' | 'unverifiable' | 'unenumerable'

export type HostRelayEndpointCensus = { verdict: HostRelayEndpointVerdict; count: number }

const MAX_CENSUS_ENDPOINTS = 32

/**
 * Every relay socket under this user's relay directories, whichever target or desktop bound it:
 * the socket name hashes the target id, and another desktop's target id is not ours to know.
 */
export function hostRelayEndpointListCommand(remoteHome: string): string {
  return [
    `base=${shellEscape(`${remoteHome}/${RELAY_REMOTE_DIR}`)}`,
    `short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`,
    'for sock in "$base"/relay-*/relay*.sock "$short_base"/relay-*/relay*.sock; do',
    '  [ -S "$sock" ] && printf \'%s\\n\' "$sock"',
    'done',
    'true'
  ].join('\n')
}

export async function censusHostRelayEndpoints(
  conn: SshConnection,
  args: {
    host: RemoteHostPlatform
    remoteHome: string
    /** A Node for endpoints whose daemon is not running; null when the host has none. */
    fallbackNodePath: () => Promise<string | null>
    signal?: AbortSignal
  }
): Promise<HostRelayEndpointCensus> {
  if (isWindowsRemoteHost(args.host)) {
    return { verdict: 'unenumerable', count: 0 }
  }
  let listing: string
  try {
    listing = await execCommand(conn, hostRelayEndpointListCommand(args.remoteHome), {
      wrapCommand: true,
      signal: args.signal
    })
  } catch {
    return { verdict: 'unverifiable', count: 0 }
  }
  const endpoints = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
  if (endpoints.length === 0) {
    return { verdict: 'none', count: 0 }
  }
  if (endpoints.length > MAX_CENSUS_ENDPOINTS) {
    return { verdict: 'unverifiable', count: endpoints.length }
  }
  // Each relay is asked with the runtime it runs on; a dead daemon's socket with any runtime here.
  const runtimes = await readRelayDaemonRuntimes(conn, args.signal)
  const anyRuntime = runtimes.values().next().value ?? null
  let fallback: Promise<string | null> | undefined
  const runtimeFor = async (endpoint: string): Promise<string | null> =>
    runtimes.get(endpoint) ??
    anyRuntime ??
    (await (fallback ??= args.fallbackNodePath().catch(() => null)))
  let live = 0
  let unverifiable = 0
  for (const endpoint of endpoints) {
    const nodePath = await runtimeFor(endpoint)
    const outcome = nodePath
      ? await classifyEndpoint(conn, args.host, nodePath, endpoint, args.signal)
      : 'unverifiable'
    if (outcome === 'live') {
      live += 1
    } else if (outcome === 'unverifiable') {
      unverifiable += 1
    }
  }
  if (live > 0) {
    return { verdict: 'live', count: live }
  }
  return unverifiable > 0
    ? { verdict: 'unverifiable', count: unverifiable }
    : { verdict: 'idle', count: 0 }
}

/**
 * The probe proves a relay idle only when it can read its whole process tree; otherwise the relay
 * itself is asked, and only when it cannot answer does the probe's conservative reading stand.
 */
async function classifyEndpoint(
  conn: SshConnection,
  host: RemoteHostPlatform,
  nodePath: string,
  endpoint: string,
  signal: AbortSignal | undefined
): Promise<'idle' | 'live' | 'unverifiable'> {
  let outcome: ReturnType<typeof classifySupersededRelay>
  try {
    outcome = classifySupersededRelay(
      await probeRelayEndpointIncumbent(conn, host, nodePath, endpoint, { signal })
    )
  } catch {
    outcome = 'unverifiable'
  }
  if (outcome === 'reap-candidate' || outcome === 'stale-endpoint-removed') {
    return 'idle'
  }
  const ptys = await countRelayEndpointPtys(conn, nodePath, endpoint, signal)
  if (ptys !== null) {
    return ptys > 0 ? 'live' : 'idle'
  }
  return outcome === 'retained-live-work' ? 'live' : 'unverifiable'
}
