import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import { refreshCodexTitleFromIndex } from './session-scanner-codex-cached-title'
import { readCodexStateThreadMetadata } from './session-scanner-codex-state-threads'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'

// Cache hits skip the parser entirely, so the same lazily-written Codex metadata
// the parser folds in at finalize has to be re-applied to the restored session.
export async function refreshCachedCodexMetadata(
  candidate: SessionFileCandidate,
  session: AiVaultSession
): Promise<AiVaultSession> {
  const refreshed = await refreshCodexTitleFromIndex(session, (sessionId) =>
    readCodexSessionIndexTitle(candidate.file.path, candidate.codexHome, sessionId)
  )
  if (refreshed.cwd && refreshed.branch && refreshed.updatedAt) {
    return refreshed
  }
  const state = await readCodexStateThreadMetadata(candidate.codexHome, session.sessionId)
  if (!state) {
    return refreshed
  }
  return {
    ...refreshed,
    cwd: refreshed.cwd ?? state.cwd,
    branch: refreshed.branch ?? state.branch,
    updatedAt: refreshed.updatedAt ?? state.updatedAt
  }
}
