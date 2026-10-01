/**
 * D7: whether live terminals survive an orcad restart onto another build.
 *
 * The daemon outlives every orcad restart, so after the swap the incoming build must route
 * sessions owned by a daemon that may speak another protocol. It can only when it speaks that
 * protocol or lists it as previous — the same rule `config/scripts/daemon-protocol-facts.mjs`
 * (`canAttach`) applies to release pairs in CI.
 */
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import type { OrcadTerminalCensus } from './orcad-update-plan'

export type OrcadDaemonProtocolFacts = {
  protocolVersion: number
  previousProtocolVersions: readonly number[]
}

/** This client's build, which is also the orcad bundle it deploys. */
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
  | 'no-live-terminals'
  | 'attachable'
  | 'strands-live-terminals'
  | 'unverifiable'

/** An unknown session count or daemon protocol is planned for as live and unattachable. */
export function assessOrcadLiveDaemonCrossing(
  census: OrcadTerminalCensus,
  incoming: OrcadDaemonProtocolFacts
): OrcadLiveDaemonCrossing {
  if (census.liveSessions === 0) {
    return 'no-live-terminals'
  }
  if (census.daemonProtocolVersion === null) {
    return 'unverifiable'
  }
  return orcadBuildCanAttachDaemon(incoming, census.daemonProtocolVersion)
    ? 'attachable'
    : 'strands-live-terminals'
}
