/** Census all account-owned relays, including other desktops, before a session exists. Failed/truncated listings and unknown endpoints stay unverifiable; lost contact never proves exit (docs/reference/ssh-execution-boundary.md). */
import type { SshConnection } from '../connection/ssh-connection'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../remote-exec/remote-frame-protocol'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from '../relay-socket-path-limit'
import { execCommand } from '../remote-exec/remote-exec-command'
import {
  isReapableRelayHusk,
  probeRelayEndpointIncumbent,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { countRelayEndpointPtys } from './ssh-relay-endpoint-pty-count'
import { readRelayDaemonRuntimes } from './ssh-relay-endpoint-runtime'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../ssh-remote-platform'

/** `unenumerable`: Windows named pipes cannot be listed, so the caller keeps today's path. */
type HostRelayEndpointVerdict = 'none' | 'idle' | 'live' | 'unverifiable' | 'unenumerable'

export type HostRelayEndpointCensus = { verdict: HostRelayEndpointVerdict; count: number }

const MAX_CENSUS_ENDPOINTS = 32

/** Other desktops hash different target ids; list every socket in this account's relay directories. */
function hostRelayEndpointListCommand(remoteHome: string): string {
  return [
    `base=${quotePosixShell(`${remoteHome}/${RELAY_REMOTE_DIR}`)}`,
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
  // Use each daemon's runtime; a dead socket may use any available Node.
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

/** Prove idle from a complete process tree or the relay's own reply; otherwise retain the conservative probe verdict. */
async function classifyEndpoint(
  conn: SshConnection,
  host: RemoteHostPlatform,
  nodePath: string,
  endpoint: string,
  signal: AbortSignal | undefined
): Promise<'idle' | 'live' | 'unverifiable'> {
  let reading: RelayEndpointProbeReading
  try {
    reading = readRelayEndpointProbe(
      await probeRelayEndpointIncumbent(conn, host, nodePath, endpoint, { signal })
    )
  } catch {
    reading = 'unverifiable'
  }
  if (reading === 'idle') {
    return 'idle'
  }
  const ptys = await countRelayEndpointPtys(conn, nodePath, endpoint, signal)
  if (ptys !== null) {
    return ptys > 0 ? 'live' : 'idle'
  }
  return reading === 'holds-work' ? 'live' : 'unverifiable'
}

type RelayEndpointProbeReading = 'idle' | 'holds-work' | 'unverifiable'

/** `idle`: a socket nothing holds, or a relay proven to hold nothing but its own services. */
export function readRelayEndpointProbe(
  incumbent: RelayEndpointIncumbent
): RelayEndpointProbeReading {
  if (incumbent.verdict === 'exited') {
    return incumbent.socketPresent ? 'idle' : 'unverifiable'
  }
  if (incumbent.verdict !== 'live') {
    return 'unverifiable'
  }
  return isReapableRelayHusk(incumbent) ? 'idle' : 'holds-work'
}
