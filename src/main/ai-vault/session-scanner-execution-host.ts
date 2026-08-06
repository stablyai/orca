import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { buildAiVaultSessionId } from '../../shared/ai-vault-session-id'

/** Rebinds a scanned session to the host that produced it, re-deriving the row
 *  id so the same transcript on two hosts stays two distinct rows. */
export function withSessionExecutionHost(
  session: AiVaultSession,
  executionHostId: ExecutionHostId
): AiVaultSession {
  if (session.executionHostId === executionHostId) {
    return session
  }
  return {
    ...session,
    executionHostId,
    id: buildAiVaultSessionId({
      executionHostId,
      agent: session.agent,
      sessionId: session.sessionId,
      filePath: session.filePath,
      previousId: session.id
    })
  }
}
