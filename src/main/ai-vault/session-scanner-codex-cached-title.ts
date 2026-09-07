import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import { readCodexSessionIndexTitle } from './session-scanner-codex-title-index'

/**
 * Codex names a thread in <CODEX_HOME>/session_index.jsonl asynchronously,
 * after the rollout exists — often after the rollout's last append. A parse
 * cache keyed on the transcript's own mtime/size therefore freezes the fallback
 * title forever, so every reuse path re-derives it through here.
 *
 * Both caches share this: `session-scanner-parse-cache.ts` (local disk, via
 * `refreshCachedCodexTitle`) and `remote-session-parse-cache.ts` (relay
 * provider, whose reader lives in `remote-session-scanner-codex-index.ts`).
 */
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
