/**
 * The connect-time relay census on a Windows host, before any relay session exists.
 *
 * Every relay pipe on the machine is listed, whichever desktop's target launched it, and each one
 * this account's version directories account for is asked through its own bridge, with its own
 * credential, for `pty.listProcesses`. A pipe no directory here accounts for is set aside only when
 * the host proves it another Windows account's; otherwise it is unverifiable, as is a listing that
 * failed or a live pipe that cannot be asked: a shell no lease here knows must never let the host
 * convert under it.
 */
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { RELAY_INSTALL_MODEL } from './remote-install-model'
import type { HostRelayEndpointCensus } from './ssh-host-relay-endpoint-census'
import {
  windowsPipesNotRunHere,
  parseWindowsRelayInventory,
  windowsPipeAccessCommand,
  windowsRelayInventoryCommand
} from './ssh-host-relay-windows-inventory'
import { countRelayPtysOverBridge } from './ssh-relay-endpoint-pty-count'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { windowsRelayConnectCommand } from './ssh-relay-windows-launch-command'
import { listRemoteInstallBaseDirsCommand } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { isNodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { orcadNodeRuntimeExecutable } from '../../shared/orcad-artifacts'
import { nodeRuntimeStoreDir, remoteNodeRuntimePresentCommand } from './orcad-remote-node-runtime'
import { REMOTE_NODE_RUNTIME_READY } from './orcad-remote-node-runtime-report'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'

const MAX_CENSUS_PIPES = 32

export async function censusWindowsHostRelays(
  conn: SshConnection,
  args: {
    host: RemoteHostPlatform
    remoteHome: string
    targetId: string
    /** Resolved only when a version directory exists; null when the host has no Node to probe with. */
    nodePath: () => Promise<string | null>
    signal?: AbortSignal
  }
): Promise<HostRelayEndpointCensus> {
  const { host, remoteHome, signal } = args
  const run = (command: string): Promise<string> =>
    execCommand(conn, command, { wrapCommand: false, signal })
  let listing: string
  try {
    listing = await run(
      listRemoteInstallBaseDirsCommand(
        host,
        joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR),
        RELAY_INSTALL_MODEL
      )
    )
  } catch {
    return { verdict: 'unverifiable', count: 0 }
  }
  if (!listing.split('\n').some((line) => line.trim().startsWith('relay-'))) {
    return { verdict: 'none', count: 0 }
  }
  const nodePath = await args.nodePath().catch(() => null)
  if (!nodePath) {
    return { verdict: 'unverifiable', count: 0 }
  }
  const inventory = await run(windowsRelayInventoryCommand(host, nodePath, remoteHome)).then(
    (output) =>
      parseWindowsRelayInventory(
        host,
        remoteHome,
        [relaySocketNameForInstanceId(args.targetId)],
        output
      ),
    () => null
  )
  if (!inventory) {
    return { verdict: 'unverifiable', count: 0 }
  }
  if (inventory.pipes.length > MAX_CENSUS_PIPES) {
    return { verdict: 'unverifiable', count: inventory.pipes.length }
  }
  const unowned = inventory.pipes.filter((pipe) => !inventory.owners.has(pipe.toLowerCase()))
  const foreign =
    unowned.length === 0
      ? new Set<string>()
      : await run(windowsPipeAccessCommand(host, nodePath, remoteHome, unowned)).then(
          windowsPipesNotRunHere,
          () => new Set<string>()
        )
  let live = 0
  let unverifiable = unowned.filter((pipe) => !foreign.has(pipe.toLowerCase())).length
  for (const pipe of inventory.pipes) {
    const owner = inventory.owners.get(pipe.toLowerCase())
    if (!owner) {
      continue
    }
    const ptys = await countRelayPtysOverBridge(
      conn,
      windowsRelayConnectCommand(host, nodePath, owner.dir, pipe, owner.credentialFile),
      signal,
      { wrapCommand: false }
    )
    if (ptys === null) {
      unverifiable += 1
    } else if (ptys > 0) {
      live += 1
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
 * The Node a Windows census probes and bridges with: the pinned runtime relays on this host run on,
 * when it is published, else the host's own Node.
 */
export async function windowsCensusNodePath(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  signal?: AbortSignal
): Promise<string | null> {
  const target = `${host.os}-${host.arch}`
  if (isNodeRuntimeTarget(target)) {
    const runtimeDir = nodeRuntimeStoreDir(
      host,
      joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR),
      target
    )
    const present = await execCommand(conn, remoteNodeRuntimePresentCommand(host, runtimeDir), {
      wrapCommand: false,
      signal
    }).catch(() => '')
    if (present.trim() === REMOTE_NODE_RUNTIME_READY) {
      return joinRemotePath(host, runtimeDir, orcadNodeRuntimeExecutable(target))
    }
  }
  return resolveRemoteNodePath(conn, host, { signal }).catch(() => null)
}
