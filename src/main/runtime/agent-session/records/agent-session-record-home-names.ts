// The one place a teammate's Home is titled. On the owner's host its title comes from the teammate's
// share row, the only copy of their name: the record store's reads put "<name>’s Home" on the record
// (their email until a name arrives), and nothing ever writes it. A name the owner gave the Home wins.
// Everything else that shows a Home reads the store; a census test keeps it that way.
import type { Bot } from '../../../../shared/bot-types'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { AgentSessionClearedFromIndex } from './agent-session-cleared-from-index'
import { botHomeName, botHomes, legacyTeammateHomeNames } from '../../../../shared/bots/bot-home-of'

type NamedRecord = { sessionId: string; conversationName?: string; conversationNameSource?: 'user' }

/** A teammate Home's title, and the names Orca saved on one in older builds (not the owner's). */
type TeammateHome = { name: string; orcaNames: ReadonlySet<string> }

/** The bots whose share rows title their teammates' Homes: the store's own dependency, handed to it
 *  by whoever opens it (agent-session-record-store-slot.ts). */
export type TeammateHomeBots = () => readonly Pick<Bot, 'chatSessionId' | 'shares'>[]

/** Each teammate Home's title by its /clear root. */
function teammateHomesByRoot(
  bots: readonly Pick<Bot, 'chatSessionId' | 'shares'>[],
  rootOf: (sessionId: string) => string
): ReadonlyMap<string, TeammateHome> {
  const homes = new Map<string, TeammateHome>()
  for (const bot of bots) {
    for (const home of botHomes(bot)) {
      if (home.of !== 'owner') {
        homes.set(rootOf(home.sessionId), {
          name: botHomeName(bot, home.of),
          orcaNames: new Set(legacyTeammateHomeNames(bot, home.of))
        })
      }
    }
  }
  return homes
}

const derived = new WeakMap<object, { name: string; record: object }>()

/** The record as readers see it: a teammate's Home bears its title unless the owner named it. The
 *  same object back for the same record and title, so readers comparing records see no change. */
export function withTeammateHomeName<R extends NamedRecord>(
  record: R,
  home: TeammateHome | undefined
): R {
  if (
    !home ||
    (record.conversationNameSource === 'user' &&
      (record.conversationName === home.name || !home.orcaNames.has(record.conversationName ?? '')))
  ) {
    return record
  }
  const kept = derived.get(record)
  if (kept?.name === home.name) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: kept is the spread of this very record.
    return kept.record as R
  }
  const next = { ...record, conversationName: home.name, conversationNameSource: 'user' as const }
  derived.set(record, { name: home.name, record: next })
  return next
}

/** A teammate's Home title, for a Home row with no chat yet (the chats tree's placeholder). */
export function teammateHomeTitle(bot: Pick<Bot, 'shares'>, accountId: string): string {
  return botHomeName(bot, { accountId })
}

/** Each teammate Home's title by the session its share points at: what a share change is compared
 *  by, and what the chats-tree index keys its cache on. */
export function teammateHomeTitlesBySession(
  bot: Pick<Bot, 'chatSessionId' | 'shares'>
): Map<string, string> {
  return new Map(
    botHomes(bot).flatMap((home) =>
      home.of === 'owner' ? [] : [[home.sessionId, botHomeName(bot, home.of)] as const]
    )
  )
}

/** A store's reads as readers see them: each teammate Home titled, matched by its /clear root. The
 *  titles are rebuilt only when the bots or the /clear lineage change, so a hot read is one lookup. */
export function recordHomeTitles(
  conversations: () => readonly Pick<
    AgentSessionConversationView,
    'sessionId' | 'conversationCommand'
  >[],
  lineage: () => object,
  bots: TeammateHomeBots
) {
  const cleared = new AgentSessionClearedFromIndex({ conversations, lineage })
  let kept: { bots: object; lineage: object; homes: ReadonlyMap<string, TeammateHome> } | null =
    null
  const homes = () => {
    const now = { bots: bots(), lineage: lineage() }
    if (kept?.bots !== now.bots || kept.lineage !== now.lineage) {
      kept = { ...now, homes: teammateHomesByRoot(now.bots, cleared.rootOf) }
    }
    return kept.homes
  }
  const all = <R extends NamedRecord>(records: R[]): R[] => {
    const titled = homes()
    return titled.size === 0
      ? records
      : records.map((record) =>
          withTeammateHomeName(record, titled.get(cleared.rootOf(record.sessionId)))
        )
  }
  return {
    all,
    one: <R extends NamedRecord>(record: R | null): R | null =>
      record ? (all([record])[0] ?? null) : null,
    /** Titled as a teammate's Home: Orca never names it from its content. */
    isHome: (sessionId: string): boolean => homes().has(cleared.rootOf(sessionId)),
    clearedFrom: cleared.clearedFrom
  }
}
