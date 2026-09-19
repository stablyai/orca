import { readOrcadHostSessionInventory } from './orcad-host-session-inventory'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

type SessionInventory = {
  listSessions(): Promise<{ createdAt: number }[]>
}

export async function collectOrcadTerminalCensus(
  activatedAt: number,
  provider?: SessionInventory | null
): Promise<OrcadTerminalCensus> {
  const sessions =
    provider === undefined ? await readOrcadHostSessionInventory() : await readSessions(provider)
  if (!sessions) {
    return { liveSessions: null, startedSinceActivation: null }
  }
  const timestampsAreKnown = sessions.every(
    (session) => Number.isFinite(session.createdAt) && session.createdAt > 0
  )
  return {
    liveSessions: sessions.length,
    startedSinceActivation: timestampsAreKnown
      ? sessions.filter((session) => session.createdAt >= activatedAt).length
      : null
  }
}

async function readSessions(
  provider: SessionInventory | null
): Promise<{ createdAt: number }[] | null> {
  try {
    return provider ? await provider.listSessions() : null
  } catch {
    return null
  }
}
