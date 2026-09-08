import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import { refreshCodexTitleFromIndex } from './session-scanner-codex-cached-title'
import { readCodexStateThreadMetadata } from './session-scanner-codex-state-threads'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'

// Cache hits skip the parser entirely, so the same lazily-written Codex metadata
// the parser folds in at finalize has to be re-applied to the restored session.
export async function refreshCachedCodexMetadata<
  T extends Pick<AiVaultSession, 'sessionId' | 'title' | 'cwd' | 'branch' | 'updatedAt'>
>(candidate: SessionFileCandidate, session: T): Promise<T> {
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
  const cwd = refreshed.cwd ?? state.cwd
  const branch = refreshed.branch ?? state.branch
  const updatedAt = refreshed.updatedAt ?? state.updatedAt
  // Callers key an index write off reference identity, and a session the state DB
  // cannot complete either (no branch on a detached HEAD) fills in nothing.
  if (cwd === refreshed.cwd && branch === refreshed.branch && updatedAt === refreshed.updatedAt) {
    return refreshed
  }
  return { ...refreshed, cwd, branch, updatedAt }
}
