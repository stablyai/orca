/** List this target's legacy sockets/pipes and their own bridge commands without changing them; other desktops hash different target ids. COMPAT(legacy-relay-bridge): revisit 2027-01-15. */
import type { SshConnection } from '../connection/ssh-connection'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../remote-exec/remote-frame-protocol'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from '../relay-socket-path-limit'
import { execCommand } from '../remote-exec/remote-exec-command'
import { readRelayDaemonRuntimes } from './ssh-relay-endpoint-runtime'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { probeRelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { readRemoteHomeCommand } from '../ssh-remote-commands'
import { resolveRemoteNodePath } from '../ssh-remote-node-resolution'
import { detectRemoteHostPlatform } from '../ssh-remote-platform-detection'
import {
  isWindowsRemoteHost,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../ssh-remote-platform'
import {
  parseWindowsRelayInventory,
  windowsRelayInventoryCommand
} from './ssh-host-relay-windows-inventory'
import { windowsCensusNodePath } from './ssh-host-relay-windows-census'
import { windowsRelayConnectCommand } from './ssh-relay-windows-launch-command'

const MAX_ENDPOINTS = 32

export type LegacyRelayEndpoint = {
  endpoint: string
  /** Null when no Node runtime is available for this relay's own bridge. */
  connectCommand: string | null
  /** POSIX commands run through the login-shell wrapper; Windows PowerShell commands do not. */
  wrapCommand: boolean
  host: RemoteHostPlatform
  nodePath: string | null
}

export type LegacyRelayEndpointListing =
  | {
      kind: 'listed'
      endpoints: LegacyRelayEndpoint[]
      /** False when a relay may run that no endpoint here accounts for, so absence proves nothing. */
      exhaustive: boolean
    }
  | { kind: 'unverifiable' }

export function legacyRelayEndpointListCommand(remoteHome: string, sockName: string): string {
  const name = quotePosixShell(sockName)
  return [
    `base=${quotePosixShell(`${remoteHome}/${RELAY_REMOTE_DIR}`)}`,
    `short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`,
    `for sock in "$base"/relay-*/${name} "$short_base"/relay-*/${name}; do`,
    '  [ -S "$sock" ] && printf \'%s\\n\' "$sock"',
    'done',
    'true'
  ].join('\n')
}

/** Use the relay's own version/hash. Short /tmp sockets still keep relay.js and credentials in the matching ~/.orca-remote/relay-<version>/. */
export function posixLegacyRelayConnectCommand(
  remoteHome: string,
  nodePath: string,
  sockPath: string
): string | null {
  const slash = sockPath.lastIndexOf('/')
  const sockDir = sockPath.slice(0, slash)
  const versionDir = sockDir.slice(sockDir.lastIndexOf('/') + 1)
  const sockName = sockPath.slice(slash + 1)
  if (slash <= 0 || !versionDir.startsWith('relay-') || !sockName) {
    return null
  }
  const relayDir = `${remoteHome}/${RELAY_REMOTE_DIR}/${versionDir}`
  return (
    `cd ${quotePosixShell(relayDir)} && ${quotePosixShell(nodePath)} relay.js --connect ` +
    `--sock-path ${quotePosixShell(sockPath)} ` +
    `--credential-file ${quotePosixShell(`${relayDir}/${sockName}.credential`)}`
  )
}

export async function listLegacyRelayEndpoints(
  conn: SshConnection,
  targetId: string,
  signal?: AbortSignal
): Promise<LegacyRelayEndpointListing> {
  try {
    const host = await detectRemoteHostPlatform(conn, { signal })
    if (!host) {
      return { kind: 'unverifiable' }
    }
    const windows = isWindowsRemoteHost(host)
    const remoteHome = normalizeRemoteHome(
      await execCommand(conn, readRemoteHomeCommand(host), { signal, wrapCommand: !windows }),
      host
    )
    if (!validateRemoteHome(remoteHome, host)) {
      return { kind: 'unverifiable' }
    }
    const sockName = relaySocketNameForInstanceId(targetId)
    return windows
      ? await listWindowsEndpoints(conn, host, remoteHome, sockName, signal)
      : await listPosixEndpoints(conn, host, remoteHome, sockName, signal)
  } catch {
    return { kind: 'unverifiable' }
  }
}

async function listPosixEndpoints(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  sockName: string,
  signal: AbortSignal | undefined
): Promise<LegacyRelayEndpointListing> {
  const listing = await execCommand(conn, legacyRelayEndpointListCommand(remoteHome, sockName), {
    signal,
    wrapCommand: true
  })
  const sockets = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
  if (sockets.length > MAX_ENDPOINTS) {
    return { kind: 'unverifiable' }
  }
  if (sockets.length === 0) {
    return { kind: 'listed', endpoints: [], exhaustive: true }
  }
  // Use each daemon's runtime; a dead socket may use any available Node.
  const runtimes = await readRelayDaemonRuntimes(conn, signal)
  let fallback: Promise<string | null> | undefined
  const endpoints: LegacyRelayEndpoint[] = []
  for (const sockPath of sockets) {
    const nodePath =
      runtimes.get(sockPath) ??
      (await (fallback ??= resolveRemoteNodePath(conn, host, { signal }).catch(() => null)))
    endpoints.push({
      endpoint: sockPath,
      connectCommand: nodePath
        ? posixLegacyRelayConnectCommand(remoteHome, nodePath, sockPath)
        : null,
      wrapCommand: true,
      host,
      nodePath
    })
  }
  return { kind: 'listed', endpoints, exhaustive: true }
}

/** Map pipes to this account through its version directories; pipes have no inode to list. */
async function listWindowsEndpoints(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  sockName: string,
  signal: AbortSignal | undefined
): Promise<LegacyRelayEndpointListing> {
  const nodePath = await windowsCensusNodePath(conn, host, remoteHome, signal)
  if (!nodePath) {
    return { kind: 'unverifiable' }
  }
  const inventory = parseWindowsRelayInventory(
    host,
    remoteHome,
    [sockName],
    await execCommand(conn, windowsRelayInventoryCommand(host, nodePath, remoteHome), {
      signal,
      wrapCommand: false
    })
  )
  if (!inventory || inventory.pipes.length > MAX_ENDPOINTS) {
    return { kind: 'unverifiable' }
  }
  const credentialName = `${sockName}.credential`.toLowerCase()
  const endpoints: LegacyRelayEndpoint[] = []
  // Unmapped pipes may still belong to this account, so absence cannot prove exit.
  let exhaustive = true
  for (const pipe of inventory.pipes) {
    const owner = inventory.owners.get(pipe.toLowerCase())
    if (!owner) {
      exhaustive = false
      continue
    }
    if (!owner.credentialFile.toLowerCase().endsWith(credentialName)) {
      continue
    }
    endpoints.push({
      endpoint: pipe,
      connectCommand: windowsRelayConnectCommand(
        host,
        nodePath,
        owner.dir,
        pipe,
        owner.credentialFile
      ),
      wrapCommand: false,
      host,
      nodePath
    })
  }
  return { kind: 'listed', endpoints, exhaustive }
}

/** Proven POSIX exit requires refused connect, complete no-holder evidence and local storage; Windows pipes remain unverifiable. */
export async function posixEndpointExited(
  conn: SshConnection,
  endpoint: LegacyRelayEndpoint
): Promise<boolean> {
  if (isWindowsRemoteHost(endpoint.host) || !endpoint.nodePath) {
    return false
  }
  const incumbent = await probeRelayEndpointIncumbent(
    conn,
    endpoint.host,
    endpoint.nodePath,
    endpoint.endpoint
  )
  return incumbent.verdict === 'exited'
}
