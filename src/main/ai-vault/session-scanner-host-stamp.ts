import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { buildAiVaultSessionId } from '../../shared/ai-vault-session-id'

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
