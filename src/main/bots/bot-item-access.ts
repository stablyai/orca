// Which items a person may see and change: the one place every item read and write asks. Each item
// is one person's (`actsForAccount`: a teammate's Orca account, or null for the owner's, as every
// item from before teammates reads). The owner, on his own devices and in his own chats, reaches
// everyone's; anyone else only their own.
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { BotShareCallerScope } from '../runtime/rpc/callers/rpc-caller-scope'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from './bot-conversation-acts-for'
import type { BotItemListQuery } from './bot-items-reads'
import type { BotItemRecord } from './bot-items-schema'
import { type BotTurnAudience, botTurnAudienceOf } from './bot-turn-audience'

export type BotItemAccess =
  | { kind: 'everyone' }
  /** One person's items: a teammate's account, or null for the owner's own. */
  | { kind: 'person'; account: string | null }

export const BOT_ITEMS_EVERYONE: BotItemAccess = { kind: 'everyone' }

export function botItemsOfPerson(account: string | null): BotItemAccess {
  return { kind: 'person', account }
}

/** Whose items a turn's own person has: a teammate's chat, theirs; any other chat, the owner's. */
export function botItemPersonOfAudience(audience: BotTurnAudience): string | null {
  return audience.kind === 'teammate' ? audience.accountId : null
}

/** What a chat reaches through the items commands: everyone's from the owner's own chats, else only
 *  its person's (a Slack or GitHub asker's chat, or one Orca never recorded, reaches the owner's). */
export function botItemAccessOfAudience(audience: BotTurnAudience): BotItemAccess {
  return audience.kind === 'owner'
    ? BOT_ITEMS_EVERYONE
    : botItemsOfPerson(botItemPersonOfAudience(audience))
}

function chatAudience(sources: BotConversationActsForSources, sessionId: string): BotTurnAudience {
  const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  return botTurnAudienceOf(readBotConversationActsFor(sources, root)?.actsFor)
}

/** The person an item a chat adds is for. */
export function botItemPersonOfChat(
  sources: BotConversationActsForSources,
  sessionId: string
): string | null {
  return botItemPersonOfAudience(chatAudience(sources, sessionId))
}

/** What a caller reaches: a teammate's own connection, their items; a chat or worker on this host,
 *  what its chat reaches; the owner's own CLI or devices (no session), everyone's. */
export function botItemAccessOfCaller(
  sources: BotConversationActsForSources,
  caller: { share?: BotShareCallerScope | null; sessionId?: string | null }
): BotItemAccess {
  if (caller.share) {
    return botItemsOfPerson(caller.share.accountId)
  }
  return caller.sessionId
    ? botItemAccessOfAudience(chatAudience(sources, caller.sessionId))
    : BOT_ITEMS_EVERYONE
}

export function botItemAccessible(
  access: BotItemAccess,
  item: Pick<BotItemRecord, 'actsForAccount'>
): boolean {
  return access.kind === 'everyone' || access.account === item.actsForAccount
}

/** The list query's part for `access`. */
export function botItemListScope(access: BotItemAccess): Pick<BotItemListQuery, 'actsForAccount'> {
  return access.kind === 'everyone' ? {} : { actsForAccount: access.account }
}
