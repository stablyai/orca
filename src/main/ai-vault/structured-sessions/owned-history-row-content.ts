import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A head row whose store History cannot read shows its chat's last turn, so it is not listed as empty. */
export function ownedRowLastTurnPreview(
  session: AiVaultSession,
  chatSessionId: string
): Pick<AiVaultSession, 'previewMessages'> | null {
  if (isAiVaultSessionResumableContent(session)) {
    return null
  }
  const lastTurn = getStructuredAgentSessionHost()?.deps.store.getRecord(chatSessionId)?.lastTurn
  const timestamp = lastTurn ? new Date(lastTurn.at).toISOString() : null
  const previewMessages = [
    ...(lastTurn?.prompt ? [{ role: 'user' as const, text: lastTurn.prompt, timestamp }] : []),
    ...(lastTurn?.reply ? [{ role: 'assistant' as const, text: lastTurn.reply, timestamp }] : [])
  ]
  return previewMessages.length > 0 ? { previewMessages } : null
}
