import { listLiveDaemonProtocols } from '../../launch/daemon-generation-liveness'
import type {
  TerminalHistoryProfile,
  TerminalReservationParticipant
} from './terminal-history-root-registry'

export async function collectTerminalHistoryReservations(
  profile: TerminalHistoryProfile,
  hosts: readonly TerminalReservationParticipant[],
  current: () => boolean
): Promise<ReadonlySet<string> | null> {
  if (!profile.runtimeDir || !profile.owned()) {
    return null
  }
  const versions = new Set(hosts.map((host) => host.protocolVersion))
  const live = await listLiveDaemonProtocols(profile.runtimeDir, [...versions])
  if (!live || live.some((version) => !versions.has(version))) {
    return null
  }
  const liveVersions = new Set(live)
  const facts = await Promise.all(
    hosts
      .filter((host) => liveVersions.has(host.protocolVersion))
      .map((host) => host.reservations().catch(() => null))
  )
  if (!current() || !profile.owned()) {
    return null
  }
  const ids = new Set(profile.localReservations())
  for (const fact of facts) {
    if (
      fact?.complete !== true ||
      typeof fact.authorityGeneration !== 'string' ||
      !fact.authorityGeneration ||
      !Array.isArray(fact.sessionIds) ||
      fact.sessionIds.some((id) => typeof id !== 'string')
    ) {
      return null
    }
    for (const id of fact.sessionIds) {
      ids.add(id)
    }
  }
  return ids
}
