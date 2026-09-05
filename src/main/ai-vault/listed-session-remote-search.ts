import { AiVaultSessionSearchIndex } from '../../shared/ai-vault-session-index'
import { sessionTranscriptIsRemoteOwned } from '../../shared/ai-vault-session-host'
import { parseVaultQuery } from '../../shared/ai-vault-session-query'
import type { AiVaultSession } from '../../shared/ai-vault-types'

export function partitionListedSearchSessions(
  sessionIds: readonly string[],
  sessionsById: ReadonlyMap<string, AiVaultSession>
): { localIds: string[]; remoteSessions: AiVaultSession[] } {
  const localIds: string[] = []
  const remoteSessions: AiVaultSession[] = []
  for (const sessionId of sessionIds) {
    const session = sessionsById.get(sessionId)
    if (session && sessionTranscriptIsRemoteOwned(session)) {
      remoteSessions.push(session)
      continue
    }
    localIds.push(sessionId)
  }
  return { localIds, remoteSessions }
}

export function matchListedSessionsByCardMetadata(
  sessions: readonly AiVaultSession[],
  query: string
): string[] {
  const terms = parseVaultQuery(query).terms
  if (sessions.length === 0 || terms.length === 0) {
    return []
  }
  const index = new AiVaultSessionSearchIndex()
  index.sync(sessions)
  return [...(index.query(terms, 'and') ?? [])]
}
