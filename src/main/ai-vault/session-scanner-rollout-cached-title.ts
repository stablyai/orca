import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readRolloutSessionIndexTitle } from './session-scanner-rollout-title-index'
import type { RolloutTitleSource, SessionFileCandidate } from './session-scanner-types'

export async function refreshCachedRolloutTitle(
  candidate: SessionFileCandidate,
  session: AiVaultSession,
  titleSource: RolloutTitleSource
): Promise<AiVaultSession> {
  if (titleSource === 'meta') {
    return session
  }
  const sessionHome = candidate.agent === 'codex' ? candidate.codexHome : null
  const title = await readRolloutSessionIndexTitle({
    sessionFilePath: candidate.file.path,
    sessionHome,
    sessionId: session.sessionId
  })
  return title && title !== session.title ? { ...session, title } : session
}
