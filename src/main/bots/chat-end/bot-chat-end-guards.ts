// The producers an end must hold off: mail and custody writes refuse inside their own transaction,
// and turns refuse at acceptance, while a bot chat is being ended or once it has ended.
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import type { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import {
  installChatCustodyGuard,
  type ChatCustodyWrite
} from '../../runtime/orchestration/db/chat-custody-guard'
import { structuredMailboxCustody } from '../../runtime/orchestration/mailbox/routing/structured-session-mail-target'
import { chatAssigneeSessionId } from '../../runtime/orchestration/workers/lifecycle/chat-assignee'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { installStructuredAgentSessionTurnGate } from '../../native-chat/agent-session-wire/operations/structured-agent-session-turn-gate'
import {
  CHAT_BEING_ENDED,
  CHAT_ENDED,
  anyChatEndFenced,
  botChatTurnRefusal,
  chatClosedToNewWork,
  isChatEndFenced
} from './bot-chat-end-fence'

export const CHAT_ENDED_CODE = 'chat_ended'

/** Mail is refused only while an end is in progress: an ended chat's address already reads ended. */
function refuseMail(db: OrchestrationDb, mailbox: string): void {
  if (!anyChatEndFenced()) {
    return
  }
  const custody = structuredMailboxCustody(mailbox, db)
  if (typeof custody === 'object' && isChatEndFenced(custody.sessionId)) {
    throw new OrchestrationError(CHAT_ENDED_CODE, CHAT_BEING_ENDED)
  }
}

/** A Dispatch assignee or Run coordinator chat that is being ended, or ended, takes no new work. */
function refuseCustody(handle: string): void {
  const chat = chatAssigneeSessionId(handle)
  if (!chat) {
    return
  }
  const store = readAgentSessionRecordStore()
  const live = store ? lineageLiveSession(store, chat)?.sessionId : undefined
  for (const id of live && live !== chat ? [chat, live] : [chat]) {
    if (chatClosedToNewWork(id)) {
      throw new OrchestrationError(
        CHAT_ENDED_CODE,
        isChatEndFenced(id) ? CHAT_BEING_ENDED : CHAT_ENDED
      )
    }
  }
}

export function botChatCustodyGuard(
  db: OrchestrationDb,
  handle: string,
  write: ChatCustodyWrite
): void {
  if (write === 'mail') {
    refuseMail(db, handle)
  } else {
    refuseCustody(handle)
  }
}

/** Installed with the bots' structured-session wiring. */
export function installBotChatEndGuards(): void {
  installChatCustodyGuard(botChatCustodyGuard)
  installStructuredAgentSessionTurnGate(botChatTurnRefusal)
}
