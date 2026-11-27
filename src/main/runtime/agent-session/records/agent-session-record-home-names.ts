// A teammate's Home on the owner's host is titled from the teammate's share row, which is the only
// copy of their name: the record store's reads put "<name>’s Home" on the record (their email until a
// name arrives), and nothing ever writes it. A name the owner gave the Home wins.
import type { Bot } from '../../../../shared/bot-types'
import { botHomeName, botHomes, legacyTeammateHomeNames } from '../../../../shared/bots/bot-home-of'

type NamedRecord = { sessionId: string; conversationName?: string; conversationNameSource?: 'user' }

/** A teammate Home's title, and the names Orca saved on one in older builds (not the owner's). */
type TeammateHome = { name: string; orcaNames: ReadonlySet<string> }

let readBots: (() => readonly Pick<Bot, 'chatSessionId' | 'shares'>[]) | null = null

/** The runtime's bots, whose share rows name their teammates' Homes. */
export function provideTeammateHomeBots(
  bots: (() => readonly Pick<Bot, 'chatSessionId' | 'shares'>[]) | null
): void {
  readBots = bots
}

let kept: { bots: object; lineage: object; homes: ReadonlyMap<string, TeammateHome> } | null = null

/** Each teammate Home's title by its /clear root; rebuilt only when the bots or the store's /clear
 *  lineage (`lineage`) change, so a hot record read costs a lookup. */
export function teammateHomesByRoot(
  rootOf: (sessionId: string) => string,
  lineage: object
): ReadonlyMap<string, TeammateHome> {
  const bots = readBots?.() ?? []
  if (kept?.bots === bots && kept.lineage === lineage) {
    return kept.homes
  }
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
  kept = { bots, lineage, homes }
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

/** A store's reads as readers see them: each teammate Home titled, by `rootOf` (its /clear root). */
export function teammateHomeTitles(source: {
  rootOf: (sessionId: string) => string
  lineage: () => object
}) {
  const homes = () => teammateHomesByRoot(source.rootOf, source.lineage())
  const all = <R extends NamedRecord>(records: R[]): R[] => {
    const titled = homes()
    return titled.size === 0
      ? records
      : records.map((record) =>
          withTeammateHomeName(record, titled.get(source.rootOf(record.sessionId)))
        )
  }
  return {
    all,
    one: <R extends NamedRecord>(record: R | null): R | null =>
      record ? (all([record])[0] ?? null) : null,
    /** Titled as a teammate's Home: Orca never names it from its content. */
    isHome: (sessionId: string): boolean => homes().has(source.rootOf(sessionId))
  }
}
