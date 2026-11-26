// What Orca's own records say about the turn a bot is running, beside whom it acts for, so its
// items and requests can keep an earlier request's key (bot-continued-request.ts reads which):
//   - the room operation that delivered the message opening it (a group member's turn);
//   - the item mail that woke it, when only Orca's item mail and workers' reports did since the turn
//     it was read from (the owner's answer or comment on an item);
//   - the turn it resumes, when Orca's own continue after a restart or a usage limit opened it.
// Never read from a message's words.
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { RESTART_CONTINUATION_ROW_PREFIX } from '../../shared/agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import { findInNativeChatTurn } from '../../shared/native-chat/transcript/continuation/native-chat-orca-stop-cut'
import { nativeChatUsageLimitOfRow } from '../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import { usageLimitContinueTag } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  readBotActingTurnWithin,
  turnWindows,
  type BotActingTurn,
  type BotActingTurnLookups
} from './bot-request-asker'
import { submissionOf } from './bot-typed-in-orca'
import { isRootTurnRecord, isRootUserMessage } from './bot-turn-messages'

function itemMailIdsOf(body: AgentJournalItemBody): string[] {
  const mail = body.kind === 'message' ? body.from?.orchestration : undefined
  return mail?.message === 'mail-notice'
    ? mail.messages.flatMap((message) =>
        message.from === BOT_ITEM_MAIL_SENDER ? [message.messageId] : []
      )
    : []
}

/** The newest item mail among the turns read back past to reach `turn`; none when `turn` is the
 *  newest, which a person or a request opened whatever mail it took. */
function itemMailIdsBefore(
  turn: BotActingTurn,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): string[] {
  for (const window of turnWindows(items, submissions, null)) {
    if (window.some((item) => item.itemId === turn.rootItemId)) {
      return []
    }
    const ids = window.flatMap((item) => itemMailIdsOf(item.body))
    if (ids.length > 0) {
      return ids
    }
  }
  return []
}

/** Orca's continue after a restart: a host send its restart continuation noted as continued. */
function restartContinued(
  opener: AgentJournalRenderItem,
  items: readonly AgentJournalRenderItem[]
) {
  for (const item of items) {
    if (item.sequence <= opener.sequence) {
      continue
    }
    if (isRootUserMessage(item)) {
      return false
    }
    const key = parseAgentJournalItemKey(item.itemId)
    if (
      item.body.kind === 'status' &&
      item.body.tone === undefined &&
      key?.provider === 'orca' &&
      key.clientMessageId.startsWith(RESTART_CONTINUATION_ROW_PREFIX)
    ) {
      return true
    }
  }
  return false
}

/** Orca's continue of a usage-limit cut: its send's id carries the tag of the cut turn before it. */
function usageLimitContinued(
  opener: AgentJournalRenderItem,
  clientMessageId: string,
  items: readonly AgentJournalRenderItem[]
): boolean {
  const tag = /^\d{13}-([0-9a-f]{16})[0-9a-f]{16}$/.exec(clientMessageId)?.[1]
  const cut = items.findLast((item) => item.sequence < opener.sequence && isRootTurnRecord(item))
  const resetsAt = cut
    ? findInNativeChatTurn(items, cut.itemId, nativeChatUsageLimitOfRow)?.resetsAt
    : undefined
  return (
    tag !== undefined &&
    cut !== undefined &&
    resetsAt !== undefined &&
    usageLimitContinueTag({ turnItemId: cut.itemId, resetsAt }) === tag
  )
}

/** `turn` as read from `items`, with what Orca's records add about it (see the top of the file). */
export function withContinuation(
  turn: BotActingTurn,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  lookups: BotActingTurnLookups
): BotActingTurn {
  const opener = items.find((item) => item.itemId === turn.rootItemId)
  const sent = opener ? submissionOf(opener, submissions) : undefined
  const itemMailIds = itemMailIdsBefore(turn, items, submissions)
  const facts = {
    ...turn,
    ...(sent ? { openerOperationId: sent.queuedMessageId ?? sent.clientMessageId } : {}),
    ...(itemMailIds.length > 0 ? { itemMailIds } : {})
  }
  const orcas =
    opener &&
    sent?.origin === 'host' &&
    sent.source === undefined &&
    sent.queuedMessageId === undefined &&
    (restartContinued(opener, items) || usageLimitContinued(opener, sent.clientMessageId, items))
  if (!opener || !orcas) {
    return facts
  }
  // The turn it resumes is read from the rows before it, as if the chat ended there.
  const earlier = items.filter((item) => item.sequence < opener.sequence)
  const prior = readBotActingTurnWithin(earlier, lookups, submissions, null)
  return {
    ...facts,
    resumes: prior?.rootItemId ? withContinuation(prior, earlier, submissions, lookups) : null
  }
}
