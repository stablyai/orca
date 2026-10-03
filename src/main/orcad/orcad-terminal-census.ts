/** The terminal census a managed orcad reports to the client planning an update or stop. */
import { listLiveDaemonSessionsWithProtocol } from '../daemon/daemon-provider-state'
import type { DaemonSessionInfo } from '../daemon/types'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

export async function collectOrcadTerminalCensus(
  activatedAt: number,
  listSessions: () => Promise<DaemonSessionInfo[] | null> = listLiveDaemonSessionsWithProtocol
): Promise<OrcadTerminalCensus> {
  let sessions: DaemonSessionInfo[] | null
  try {
    sessions = await listSessions()
  } catch {
    sessions = null
  }
  if (!sessions) {
    return UNVERIFIABLE
  }
  const timestampsKnown = sessions.every(
    (session) => Number.isFinite(session.createdAt) && session.createdAt > 0
  )
  const protocols = new Set(sessions.map((session) => session.protocolVersion))
  const [protocol] = protocols
  return {
    liveSessions: sessions.length,
    startedSinceActivation: timestampsKnown
      ? sessions.filter((session) => session.createdAt >= activatedAt).length
      : null,
    // Why one protocol only: sessions split across daemon generations have no single owner to
    // check an incoming build against, so that reads as unverifiable.
    daemonProtocolVersion: protocols.size === 1 && protocol !== undefined ? protocol : null
  }
}
