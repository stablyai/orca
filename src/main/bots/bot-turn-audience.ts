// Whom a bot chat's turns are for, from Orca's acting-for record: the one place that decides what of
// the owner's a turn hears, and who it is told is asking.
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { actsForOwner, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { inlineUntrusted } from '../../shared/quoted-text-fence'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from './bot-conversation-acts-for'
import type { BotLookAroundStore } from './bot-look-around-store'

export type BotTurnTeammate = { accountId: string; name: string }

export type BotTurnAudience =
  | { kind: 'owner' }
  /** People the owner shared the bot with, by Orca account, however they asked (in Orca, or from
   *  a Slack login linked to that account); one each, in account order. */
  | { kind: 'teammates'; people: readonly BotTurnTeammate[] }
  /** No teammate and not only the owner (a Slack or GitHub asker who isn't one, a look-around
   *  run), or not recorded yet. */
  | { kind: 'other' }

/** What a turn hears besides its person's items: `ownerWork` the owner's other chats and the bot's
 *  workers, `ownerAsks` the owner's questions, and `asker` the line naming who asks when it isn't
 *  the owner. */
export type BotTurnScope = { ownerWork: boolean; ownerAsks: boolean; asker: string | null }

const NAME_CHARS = 80

export function botTurnScope(audience: BotTurnAudience): BotTurnScope {
  switch (audience.kind) {
    case 'owner':
      return { ownerWork: true, ownerAsks: true, asker: null }
    case 'teammates':
      return { ownerWork: false, ownerAsks: false, asker: teammatesLine(audience.people) }
    case 'other':
      return { ownerWork: true, ownerAsks: false, asker: null }
  }
}

function teammatesLine(people: readonly BotTurnTeammate[]): string {
  const who = quotedNames(people)
  return people.length === 1
    ? `[Orca: this chat is ${who}'s, a teammate your owner shared you with. Messages here are from ${who}, not your owner.]`
    : `[Orca: this chat is for ${who}, teammates your owner shared you with. Messages here are from them, not your owner.]`
}

/** The line naming who asks this turn's message: its typist when that isn't whom the chat is for
 *  (a teammate in the owner's chat or another's, the owner in a teammate's), else the chat's. */
export function botTurnAskerLine(
  audience: BotTurnAudience,
  typist: 'owner' | BotRequestAsker | null
): string | null {
  const chatLine = botTurnScope(audience).asker
  if (typist === 'owner') {
    return audience.kind === 'teammates'
      ? `[Orca: this message is from your owner, in ${quotedNames(audience.people)}'s chat.]`
      : chatLine
  }
  const teammate = typist ? teammateOf(typist) : null
  const chatIsTheirs =
    audience.kind === 'teammates' &&
    audience.people.length === 1 &&
    audience.people[0]!.accountId === teammate?.accountId
  return teammate && !chatIsTheirs
    ? `[Orca: this message is from ${quotedNames([teammate])}, a teammate your owner shared you with, not your owner.]`
    : chatLine
}

function quotedNames(people: readonly BotTurnTeammate[]): string {
  return people.map(({ name }) => JSON.stringify(inlineUntrusted(name, NAME_CHARS))).join(', ')
}

/** The teammate an asker is, by Orca account: in Orca, or through a Slack login linked to it (as
 *  `shareOwnsChat` reads them); null for the owner or anyone else. */
function teammateOf(asker: BotRequestAsker): BotTurnTeammate | null {
  if (asker.kind !== 'person' || asker.role === 'owner') {
    return null
  }
  const accountId =
    asker.source === 'orca' ? asker.userId : asker.source === 'slack' ? asker.viaAccount : undefined
  return accountId ? { accountId, name: asker.name ?? accountId } : null
}

/** From a chat's acting-for record, the same for every channel; undefined when Orca hasn't
 *  recorded one. A chat naming any teammate is theirs, never the owner's. */
export function botTurnAudienceOf(
  actsFor: readonly BotRequestAsker[] | undefined
): BotTurnAudience {
  if (!actsFor || actsFor.length === 0) {
    return { kind: 'other' }
  }
  if (actsForOwner(actsFor)) {
    return { kind: 'owner' }
  }
  const people = new Map<string, BotTurnTeammate>()
  for (const teammate of actsFor.map(teammateOf)) {
    if (teammate && !people.has(teammate.accountId)) {
      people.set(teammate.accountId, teammate)
    }
  }
  return people.size > 0
    ? {
        kind: 'teammates',
        people: [...people.values()].toSorted((a, b) => a.accountId.localeCompare(b.accountId))
      }
    : { kind: 'other' }
}

export type BotTurnAudienceSources = BotConversationActsForSources & {
  lookAround: Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp'>
}

/** Each chat's audience; a chat's record is written once and never changes, so it is read once. */
export function createBotTurnAudience(
  sources: BotTurnAudienceSources
): (sessionId: string) => BotTurnAudience {
  const known = new Map<string, BotTurnAudience>()
  const recorded = (sessionId: string): BotTurnAudience => {
    const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
    const hit = known.get(root)
    if (hit) {
      return hit
    }
    const record = readBotConversationActsFor(sources, root)
    const audience = botTurnAudienceOf(record?.actsFor)
    // Not recorded yet: a later turn reads it again.
    if (record) {
      known.set(root, audience)
    }
    return audience
  }
  return (sessionId) => {
    // A read failure counts as nobody's, never the owner's.
    try {
      return sources.lookAround.botOfLook(sessionId) === null &&
        sources.lookAround.botOfTidyUp(sessionId) === null
        ? recorded(sessionId)
        : { kind: 'other' }
    } catch {
      return { kind: 'other' }
    }
  }
}
