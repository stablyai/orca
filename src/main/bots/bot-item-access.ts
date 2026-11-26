// Which items a person may see and change: the one place every item read and write asks. Each item
// acts for the owner (`actsForAccounts` null, as every item from before teammates reads) or for
// teammates by Orca account. The owner, on his own devices and in his own chats, reaches everyone's;
// a chat for teammates reaches only items acting for someone in it, never the owner's; any other chat
// the owner's.
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { BotShareCallerScope } from '../runtime/rpc/callers/rpc-caller-scope'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from './bot-conversation-acts-for'
import { BotItemError } from './bot-item-error'
import type { BotItemListQuery } from './bot-items-reads'
import type { BotItemRecord } from './bot-items-schema'
import { type BotTurnAudience, botTurnAudienceOf } from './bot-turn-audience'

export type BotItemAccess =
  | { kind: 'everyone' }
  /** Items acting for any of these teammates' accounts; null: the owner's own; empty: none. */
  | { kind: 'people'; accounts: readonly string[] | null }

export const BOT_ITEMS_EVERYONE: BotItemAccess = { kind: 'everyone' }

export function botItemsOfPeople(accounts: readonly string[] | null): BotItemAccess {
  return { kind: 'people', accounts }
}

/** Whom a turn's items act for: a teammates' chat, them; any other chat, the owner (null). */
export function botItemPeopleOfAudience(audience: BotTurnAudience): readonly string[] | null {
  return audience.kind === 'teammates' ? audience.people.map((person) => person.accountId) : null
}

/** What a chat reaches through the items commands: everyone's from the owner's own chats, else only
 *  its people's (a Slack or GitHub asker's chat, or one Orca never recorded, reaches the owner's). */
export function botItemAccessOfAudience(audience: BotTurnAudience): BotItemAccess {
  return audience.kind === 'owner'
    ? BOT_ITEMS_EVERYONE
    : botItemsOfPeople(botItemPeopleOfAudience(audience))
}

function chatAudience(sources: BotConversationActsForSources, chatId: string): BotTurnAudience {
  return botTurnAudienceOf(readBotConversationActsFor(sources, rootOf(chatId))?.actsFor)
}

const rootOf = (sessionId: string): string =>
  isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId

/** Whom an item a caller adds for a chat acts for: that chat's people, refused before anything is
 *  made when the caller can't reach them. */
export function botItemAddedFor(
  sources: BotConversationActsForSources,
  access: BotItemAccess,
  chatId: string
): readonly string[] | null {
  const people = botItemPeopleOfChat(sources, chatId)
  if (!botItemAccessible(access, { actsForAccounts: people })) {
    throw new BotItemError(
      'invalid_argument',
      "That chat is for someone else, so this chat can't add items there. Nothing was written."
    )
  }
  return people
}

/** Whom an item added in a chat acts for: that chat's people. */
export function botItemPeopleOfChat(
  sources: BotConversationActsForSources,
  chatId: string
): readonly string[] | null {
  return botItemPeopleOfAudience(chatAudience(sources, chatId))
}

/** What one of a bot's chats reaches. */
export function botItemAccessOfChat(
  sources: BotConversationActsForSources,
  chatId: string
): BotItemAccess {
  return botItemAccessOfAudience(chatAudience(sources, chatId))
}

/** A caller's identity, as the host has it: a chat or worker session it verified, or the terminal
 *  handle a terminal's own calls carry. */
export type BotItemCallerIdentity = { handle: string; paneKey?: string | null; sessionId?: string }

/**
 * What a caller reaches: a teammate's share device (the only caller that carries a teammate), their
 * items; one of the owner's paired computers, which is the owner, everyone's; a bot chat, what its people reach; a worker, chat or terminal
 * alike, what its Dispatch's stamp reaches (`acts_for`, copied when it was made, so a worker's worker
 * reaches the same); anything else of the owner's (his CLI, terminals and own chats), everyone's.
 */
export function botItemAccessOfCaller(
  sources: BotConversationActsForSources,
  caller: {
    /** A teammate's share device, from the share admission's scope. */
    share?: BotShareCallerScope | null
    /** One of the owner's paired computers, from its pairing. */
    peer?: boolean
    identity?: BotItemCallerIdentity | null
  }
): BotItemAccess {
  if (caller.share) {
    return botItemsOfPeople([caller.share.accountId])
  }
  // Never a paired computer's say-so about a terminal or Dispatch here: it is the owner.
  if (caller.peer) {
    return BOT_ITEMS_EVERYONE
  }
  const { identity } = caller
  if (!identity) {
    return BOT_ITEMS_EVERYONE
  }
  if (identity.sessionId && readBotConversationActsFor(sources, rootOf(identity.sessionId))) {
    return botItemAccessOfChat(sources, identity.sessionId)
  }
  const dispatch = sources
    .getOrchestrationDb()
    .getActiveDispatchForIdentity(identity.handle, identity.paneKey ?? undefined)
  if (!dispatch?.acts_for) {
    return BOT_ITEMS_EVERYONE
  }
  return botItemAccessOfAudience(botTurnAudienceOf(stampedActsFor(dispatch.acts_for)))
}

function stampedActsFor(stamp: string): BotRequestAsker[] {
  try {
    const parsed: unknown = JSON.parse(stamp)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the Dispatch insert writes it, copied from an acts-for record
    return Array.isArray(parsed) ? (parsed as BotRequestAsker[]) : [{ kind: 'unknown' }]
  } catch {
    // An unreadable stamp names no one, which reaches only the owner's own items.
    return [{ kind: 'unknown' }]
  }
}

export function botItemAccessible(
  access: BotItemAccess,
  item: Pick<BotItemRecord, 'actsForAccounts'>
): boolean {
  if (access.kind === 'everyone') {
    return true
  }
  if (access.accounts === null || item.actsForAccounts === null) {
    return access.accounts === item.actsForAccounts
  }
  const reach = new Set(access.accounts)
  return item.actsForAccounts.some((account) => reach.has(account))
}

/** The list query's part for `access`. */
export function botItemListScope(access: BotItemAccess): Pick<BotItemListQuery, 'actsForAccounts'> {
  return access.kind === 'everyone' ? {} : { actsForAccounts: access.accounts }
}
