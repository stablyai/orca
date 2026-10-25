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
  // Count in-process fallback terminals: daemon failure does not make restart safe.
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
    // Fallback terminals lack creation times, so activation-relative counts remain unknown.
    startedSinceActivation:
      timestampsKnown && inProcess === 0
        ? sessions.filter((session) => session.createdAt >= activatedAt).length
        : null,
    // Mixed daemon generations cannot establish one protocol owner for build compatibility.
    daemonProtocolVersion: protocols.size === 1 && protocol !== undefined ? protocol : null,
    inProcessSessions: inProcess
  }
}
