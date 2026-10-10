/** The terminal census a managed orcad reports to the client planning an update or stop. */
import {
  countInProcessFallbackTerminals,
  listLiveDaemonSessionsWithProtocol
} from '../daemon/daemon-provider-state'
import type { DaemonSessionInfo } from '../daemon/types'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null,
  inProcessSessions: null
}

export async function collectOrcadTerminalCensus(
  activatedAt: number,
  listSessions: () => Promise<DaemonSessionInfo[] | null> = listLiveDaemonSessionsWithProtocol,
  countInProcess: () => Promise<number> = countInProcessFallbackTerminals
): Promise<OrcadTerminalCensus> {
  // Degraded mode runs fresh terminals in orcad itself; a restart kills those too.
  let inventory: [DaemonSessionInfo[] | null, number]
  try {
    inventory = await Promise.all([listSessions(), countInProcess()])
  } catch {
    return UNVERIFIABLE
  }
  const [sessions, inProcess] = inventory
  if (!sessions) {
    return UNVERIFIABLE
  }
  const timestampsKnown = sessions.every(
    (session) => Number.isFinite(session.createdAt) && session.createdAt > 0
  )
  const protocols = new Set(sessions.map((session) => session.protocolVersion))
  const [protocol] = protocols
  return {
    liveSessions: sessions.length + inProcess,
    // In-process terminals carry no creation time to compare against activation.
    startedSinceActivation:
      timestampsKnown && inProcess === 0
        ? sessions.filter((session) => session.createdAt >= activatedAt).length
        : null,
    // Why one protocol only: sessions split across daemon generations have no single owner to
    // check an incoming build against, so that reads as unverifiable.
    daemonProtocolVersion: protocols.size === 1 && protocol !== undefined ? protocol : null,
    inProcessSessions: inProcess
  }
}
