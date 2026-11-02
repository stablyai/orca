import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'

/** Refresh cached titles independently: session_index.jsonl can change after the rollout stops growing. */
export async function refreshCodexTitleFromIndex(
  session: AiVaultSession,
  readIndexedTitle: (sessionId: string) => Promise<string | null>
): Promise<AiVaultSession> {
  const title = await readIndexedTitle(session.sessionId)
  return title && title !== session.title ? { ...session, title } : session
}

export function refreshCachedCodexTitle(
  candidate: SessionFileCandidate,
  session: AiVaultSession
): Promise<AiVaultSession> {
  return refreshCodexTitleFromIndex(session, (sessionId) =>
    readCodexSessionIndexTitle(candidate.file.path, candidate.codexHome, sessionId)
  )
}
