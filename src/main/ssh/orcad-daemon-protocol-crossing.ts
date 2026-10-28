/** Daemons outlive orcad swaps; incoming builds can attach only current/previous daemon protocols, matching config/scripts/daemon-protocol-facts.mjs canAttach. */
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

export type OrcadDaemonProtocolFacts = {
  protocolVersion: number
  previousProtocolVersions: readonly number[]
}

export const CURRENT_ORCAD_DAEMON_PROTOCOL: OrcadDaemonProtocolFacts = {
  protocolVersion: PROTOCOL_VERSION,
  previousProtocolVersions: PREVIOUS_DAEMON_PROTOCOL_VERSIONS
}

export function orcadBuildCanAttachDaemon(
  reader: OrcadDaemonProtocolFacts,
  ownerProtocolVersion: number
): boolean {
  return (
    reader.protocolVersion === ownerProtocolVersion ||
    reader.previousProtocolVersions.includes(ownerProtocolVersion)
  )
}

export type OrcadLiveDaemonCrossing =
  | { state: 'no-live-terminals' }
  | { state: 'attachable' }
  | { state: 'strands-live-terminals'; unattachable: readonly number[] }
  | { state: 'unverifiable' }

/** A counted census of live terminals from a host that predates the protocol set, so it cannot name mixed generations. */
export function censusNeedsHostDaemonProtocols(census: OrcadTerminalCensus): boolean {
  // An uncounted census may hide in-process terminals no daemon answer can vouch for.
  return (
    census.liveSessions !== null &&
    census.liveSessions > 0 &&
    census.daemonProtocolVersions === undefined &&
    census.daemonProtocolVersion === null
  )
}

function liveDaemonProtocols(
  census: OrcadTerminalCensus,
  hostDaemonProtocols: readonly number[] | undefined
): readonly number[] | null {
  if (census.daemonProtocolVersions !== undefined) {
    return census.daemonProtocolVersions
  }
  if (census.daemonProtocolVersion !== null) {
    return [census.daemonProtocolVersion]
  }
  return censusNeedsHostDaemonProtocols(census) ? (hostDaemonProtocols ?? null) : null
}

/** An unknown session count or daemon protocol is planned for as live and unattachable. */
export function assessOrcadLiveDaemonCrossing(
  census: OrcadTerminalCensus,
  incoming: OrcadDaemonProtocolFacts,
  /** Every daemon generation alive on the host, as the incoming build observed it. */
  hostDaemonProtocols?: readonly number[]
): OrcadLiveDaemonCrossing {
  if (census.liveSessions === 0) {
    return { state: 'no-live-terminals' }
  }
  const protocols = liveDaemonProtocols(census, hostDaemonProtocols)
  if (protocols === null || protocols.length === 0) {
    return { state: 'unverifiable' }
  }
  // Every generation must stay reachable; one unattachable daemon strands its terminals.
  const unattachable = protocols.filter(
    (protocol) => !orcadBuildCanAttachDaemon(incoming, protocol)
  )
  return unattachable.length === 0
    ? { state: 'attachable' }
    : { state: 'strands-live-terminals', unattachable }
}

export function describeDaemonProtocols(protocols: readonly number[]): string {
  return protocols.length === 1 ? `protocol ${protocols[0]}` : `protocols ${protocols.join(', ')}`
}
