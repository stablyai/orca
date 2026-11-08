import {
  AGENT_MESSAGE_SOURCE,
  USER_MESSAGE_SOURCE,
  type AgentSessionMessageSource
} from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionChatAction } from '../../../shared/agent-session/journal/agent-session-chat-action'
import { isSlashCommandDraft } from '../../../shared/native-chat/input/native-chat-slash-commands'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../shared/native-chat/native-chat-usage-limit-cut'

export function structuredChatAction(input: {
  body: AgentJournalMessageItem
  userSend?: true
  personsMessage?: true
  usageLimitContinuationOfTurnItemId?: string
}): AgentSessionChatAction | undefined {
  if (input.body.from || (!input.userSend && !input.personsMessage)) {
    return undefined
  }
  const text = input.body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
  // Older clients' Continue has no typed continuation field; conservatively exclude its reserved phrase.
  if (
    input.usageLimitContinuationOfTurnItemId ||
    text === NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE
  ) {
    return 'continue'
  }
  return input.body.command || isSlashCommandDraft(text) ? 'command' : 'message'
}

export function structuredSendSource(params: {
  body: AgentJournalMessageItem
  userSend?: true
  personsMessage?: true
}): AgentSessionMessageSource | undefined {
  if (params.userSend || params.personsMessage) {
    return USER_MESSAGE_SOURCE
  }
  return params.body.from ? AGENT_MESSAGE_SOURCE : undefined
}

export function queuedStructuredChatAction(card: {
  body: AgentJournalMessageItem
  chatAction?: AgentSessionChatAction
}): AgentSessionChatAction | undefined {
  return card.chatAction === 'message' || card.chatAction === 'command'
    ? structuredChatAction({ body: card.body, userSend: true })
    : card.chatAction
}
