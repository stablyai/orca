import {
  buildAgentSessionContinuationPrompt,
  resolveAgentSessionContinuationTranscriptPath
} from '../../shared/agent-session/conversation-context/agent-session-continuation'
import type { AiVaultSessionHandoffPrompts } from '../../shared/ai-vault/contracts/ai-vault-session-handoff'
import {
  prepareAiVaultSessionContinuation,
  type AiVaultContinuationSession
} from '../../shared/ai-vault/resume/ai-vault-session-continuation'
import { writeAiVaultSessionHandoffSnapshot } from './session-handoff-snapshot'
import { isCursorAcpSessionRow } from '../../shared/ai-vault/session-display/cursor-acp-session-path'

/** Desktop's History hand-off prompt for a client that shows the row but should not carry the builder. */
export async function prepareAiVaultSessionHandoffPrompts(
  session: AiVaultContinuationSession & { sessionId?: string }
): Promise<AiVaultSessionHandoffPrompts> {
  // Only its chat holds the conversation; a last-turn preview is not one to hand off.
  if (isCursorAcpSessionRow(session)) {
    return {}
  }
  const saved = await writeAiVaultSessionHandoffSnapshot(session)
  const { source } = prepareAiVaultSessionContinuation({
    session,
    // The caller launches the agent; only the prompt's source is used here.
    targetWorktreeId: '',
    targetWorkspacePath: '',
    ...(saved.transcriptPath ? { savedTranscriptPath: saved.transcriptPath } : {})
  })
  const focused = buildAgentSessionContinuationPrompt(source, 'focused')
  const full = resolveAgentSessionContinuationTranscriptPath(source)
    ? buildAgentSessionContinuationPrompt(source, 'full')
    : null
  return { ...(focused ? { focused } : {}), ...(full ? { full } : {}) }
}
