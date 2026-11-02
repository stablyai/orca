/**
 * The connect path's terminal verdict for a host that may convert to a managed server. The host's
 * own relay endpoints decide, so terminals another desktop opened there still block.
 */
import type { Store } from '../../persistence'
import type { HostServerTerminalVerdict } from '../ssh-host-server-on-connect'
import {
  censusHostRelayEndpoints,
  type HostRelayEndpointCensus
} from './ssh-host-relay-endpoint-census'
import type { SshConnection } from '../ssh-connection'
import { censusWindowsHostRelays, windowsCensusNodePath } from './ssh-host-relay-windows-census'
import { execCommand } from '../remote-exec/remote-exec-command'
import { readRemoteHomeCommand } from '../ssh-remote-commands'
import { resolveRemoteNodePath } from '../ssh-remote-node-resolution'
import { detectRemoteHostPlatform } from '../ssh-remote-platform-detection'
import {
  isWindowsRemoteHost,
  normalizeRemoteHome,
  validateRemoteHome
} from '../ssh-remote-platform'
import {
  assessOrcadMigrationTerminals,
  terminalsRunElsewhere,
  type HostRelayTerminalProof
} from '../orcad-migration-terminal-gate'

export async function relayTerminalsOnConnect(args: {
  store: Pick<Store, 'getSshRemotePtyLeases'>
  targetId: string
  censusHost: () => Promise<HostRelayEndpointCensus>
}): Promise<HostServerTerminalVerdict> {
  const proof = await assessOrcadMigrationTerminals(args.store, args.targetId, async () =>
    hostTerminalProofFromCensus(await args.censusHost())
  )
  if (proof.verdict === 'exited') {
    return { verdict: 'exited', count: 0 }
  }
  if (proof.verdict === 'bridged') {
    return { verdict: proof.relayVerdict, count: proof.hostTerminals, bridged: true }
  }
  return {
    verdict: proof.verdict,
    count: proof.ptyIds.length || (proof.hostTerminals ?? 0),
    ...(terminalsRunElsewhere(proof) ? { elsewhere: true } : {})
  }
}

/** Only a listing that found no endpoint, or only idle ones, proves exit; `unenumerable` does not. */
export function hostTerminalProofFromCensus(
  census: HostRelayEndpointCensus
): HostRelayTerminalProof {
  if (census.verdict === 'none' || census.verdict === 'idle') {
    return { verdict: 'exited', count: 0 }
  }
  return { verdict: census.verdict === 'live' ? 'live' : 'unverifiable', count: census.count }
}

/** The census over the connect's bootstrap connection, before any relay session exists. */
export async function censusSshHostRelaysBeforeSession(
  conn: SshConnection,
  targetId: string,
  signal?: AbortSignal
): Promise<HostRelayEndpointCensus> {
  const host = await detectRemoteHostPlatform(conn, { signal })
  if (!host) {
    return { verdict: 'unverifiable', count: 0 }
  }
  const windows = isWindowsRemoteHost(host)
  const remoteHome = normalizeRemoteHome(
    await execCommand(conn, readRemoteHomeCommand(host), { signal, wrapCommand: !windows }),
    host
  )
  if (!validateRemoteHome(remoteHome, host)) {
    return { verdict: 'unverifiable', count: 0 }
  }
  if (windows) {
    return censusWindowsHostRelays(conn, {
      host,
      remoteHome,
      targetId,
      nodePath: () => windowsCensusNodePath(conn, host, remoteHome, signal),
      signal
    })
  }
  return censusHostRelayEndpoints(conn, {
    host,
    remoteHome,
    fallbackNodePath: () => resolveRemoteNodePath(conn, host, { signal }),
    signal
  })
}
