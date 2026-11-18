// Who raised a bot chat's prompt, read from the journal message that opened its turn, so every prompt
// of one turn gets one answer across watches, restarts and later deliveries that join it.
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import { orchestrationMailNotice } from '../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  CONNECTOR_PROMPT_LIMITS,
  type ConnectorPromptAudience
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { isConversationReport } from './external-conversation-turn-opener'

/**
 * 'conversation' only when the turn's opening message is this conversation's own delivery, as it was
 * stamped when delivered; for a bot's thread chat, also mail finishing its ask. Anything else (mail
 * from another bot or an item, a turn typed in Orca, a message from before the stamp, a delivery from
 * the conversation the bot's Chat answered before it was linked here) is 'orca', the most restrictive.
 */
export function promptRaisedBy(
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'bot'>,
  opener: AgentJournalRenderItem | null
): 'conversation' | 'orca' {
  const body = opener?.body
  if (body?.kind !== 'message') {
    return 'orca'
  }
  const from = body.connectorConversation
  if (from && from.source === link.source && from.externalId === link.externalId) {
    return 'conversation'
  }
  return link.bot?.kind === 'bot' && isConversationReport(body) ? 'conversation' : 'orca'
}

/** Who woke the turn: the first sender of the mail that opened it, by name. */
function wokenBy(opener: AgentJournalRenderItem | null): string | undefined {
  const body = opener?.body
  if (body?.kind !== 'message' || !orchestrationMailNotice(body.from)) {
    return undefined
  }
  const name = body.from?.senders?.[0]?.name?.trim()
  return name ? [...name].slice(0, CONNECTOR_PROMPT_LIMITS.maxWokenByChars).join('') : undefined
}

const fitsId = (id: string): boolean =>
  id.length > 0 && id.length <= CONNECTOR_PROMPT_LIMITS.maxOpaqueIdLength

export function promptAudience(
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'bot' | 'sessionId'>,
  prompt: Pick<PendingPrompt, 'promptId'>,
  opener: AgentJournalRenderItem | null
): ConnectorPromptAudience {
  const raisedBy = promptRaisedBy(link, opener)
  const woken = raisedBy === 'orca' ? wokenBy(opener) : undefined
  const open = fitsId(link.sessionId)
    ? {
        sessionId: link.sessionId,
        ...(fitsId(prompt.promptId) ? { itemId: prompt.promptId } : {})
      }
    : undefined
  return { raisedBy, ...(woken ? { wokenBy: woken } : {}), ...(open ? { open } : {}) }
}
