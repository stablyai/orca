import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'

/** Refresh cached titles independently: session_index.jsonl can change after the rollout stops growing. */
export async function refreshSessionTitleFromIndex(
  session: AiVaultSession,
  readIndexedTitle: (sessionId: string) => Promise<string | null>
): Promise<AiVaultSession> {
  const title = await readIndexedTitle(session.sessionId)
  return title && (title !== session.title || session.titleKind !== 'named')
    ? { ...session, title, titleKind: 'named' }
    : session
}
