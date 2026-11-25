// Whom a bot chat's turns are for, from Orca's acting-for record: the one place that decides what of
// the owner's a turn hears, and who it is told is asking.
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import {
  actsForOwner,
  distinctAskers,
  type BotRequestAsker,
  type BotRequestPerson
} from '../../shared/bots/bot-acts-for'
import { inlineUntrusted } from '../../shared/quoted-text-fence'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from './bot-conversation-acts-for'
import type { BotLookAroundStore } from './bot-look-around-store'

export type BotTurnAudience =
  | { kind: 'owner' }
  /** People the owner shared the bot with, in their own chat. */
  | { kind: 'teammate'; names: string[] }
  /** Anyone else (a Slack or GitHub asker, a look-around run), or not recorded yet. */
  | { kind: 'other' }

/** What a turn hears: `ownerWork` the owner's live work and other chats, `ownerAsks` the owner's
 *  questions, and `asker` the line naming who asks when it isn't the owner. */
export type BotTurnScope = { ownerWork: boolean; ownerAsks: boolean; asker: string | null }

const NAME_CHARS = 80

export function botTurnScope(audience: BotTurnAudience): BotTurnScope {
  switch (audience.kind) {
    case 'owner':
      return { ownerWork: true, ownerAsks: true, asker: null }
    case 'teammate':
      return { ownerWork: false, ownerAsks: false, asker: teammateLine(audience.names) }
    case 'other':
      return { ownerWork: true, ownerAsks: false, asker: null }
  }
}

function teammateLine(names: readonly string[]): string {
  const who = names.map((name) => JSON.stringify(inlineUntrusted(name, NAME_CHARS))).join(', ')
  return `[Orca: this chat is ${who}'s, a teammate your owner shared you with. Messages here are from ${who}, not your owner.]`
}

const isTeammate = (asker: BotRequestAsker): asker is BotRequestPerson =>
  asker.kind === 'person' && asker.source === 'orca' && asker.role !== 'owner'

/** From a chat's acting-for record; undefined when Orca hasn't recorded one. */
export function botTurnAudienceOf(
  actsFor: readonly BotRequestAsker[] | undefined
): BotTurnAudience {
  if (!actsFor || actsFor.length === 0) {
    return { kind: 'other' }
  }
  if (actsForOwner(actsFor)) {
    return { kind: 'owner' }
  }
  const people = distinctAskers(actsFor)
  return people.every(isTeammate)
    ? { kind: 'teammate', names: people.map((person) => person.name ?? person.userId) }
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
