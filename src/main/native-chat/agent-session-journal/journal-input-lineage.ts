import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'

export type JournalInputContext = {
  source: AgentJournalCursor
  basis: 'observed' | 'legacy'
  cut: number
}
export type JournalCardAlias = {
  from: number
  until?: number
  coordinate: AgentJournalCursor | null
  present: boolean
}
export type JournalCardLineage = {
  messageId: string
  introduced: number
  aliases: JournalCardAlias[]
}
export type JournalInputLineage = { clock: number; cards: JournalCardLineage[] }

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const ordinal = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
export function isInputCoordinate(value: unknown): value is AgentJournalCursor {
  return (
    object(value) &&
    typeof value.epoch === 'string' &&
    value.epoch.length > 0 &&
    ordinal(value.sequence)
  )
}
export function isInputContext(value: unknown): value is JournalInputContext {
  return (
    object(value) &&
    isInputCoordinate(value.source) &&
    ordinal(value.cut) &&
    (value.basis === 'observed' || value.basis === 'legacy')
  )
}
export function isInputLineage(value: unknown): value is JournalInputLineage {
  if (!object(value) || !ordinal(value.clock) || !Array.isArray(value.cards)) {
    return false
  }
  const clock = value.clock
  const ids = new Set<string>()
  return value.cards.every((card) => {
    if (
      !object(card) ||
      typeof card.messageId !== 'string' ||
      !card.messageId ||
      ids.has(card.messageId) ||
      !ordinal(card.introduced) ||
      card.introduced > clock ||
      !Array.isArray(card.aliases)
    ) {
      return false
    }
    ids.add(card.messageId)
    let until = card.introduced
    return card.aliases.every((alias) => {
      if (
        !object(alias) ||
        !ordinal(alias.from) ||
        alias.from < until ||
        alias.from > clock ||
        !(alias.coordinate === null || isInputCoordinate(alias.coordinate)) ||
        typeof alias.present !== 'boolean' ||
        !(
          alias.until === undefined ||
          (ordinal(alias.until) && alias.until > alias.from && alias.until <= clock)
        )
      ) {
        return false
      }
      until = alias.until ?? Infinity
      return true
    })
  })
}

export function queryInputContext<T>(
  context: JournalInputContext,
  original: AgentJournalCursor | undefined,
  before: (coordinate: AgentJournalCursor) => T,
  all: () => T,
  merge: (left: T, right: T) => T
): T {
  if (context.basis === 'observed' || original?.epoch === context.source.epoch) {
    return all()
  }
  const source = before(context.source)
  return original ? merge(source, before(original)) : source
}

/** Scalar alias intervals, independent of bodies, holds and current display positions. */
export class JournalInputLineageOwner {
  readonly cards = new Map<string, JournalCardLineage>()
  private protectedThrough = -1
  private base = 0
  clock = 0

  load(lineage: JournalInputLineage): void {
    this.protectedThrough = lineage.clock
    this.base = lineage.clock
    this.clock = lineage.clock
    for (const card of lineage.cards) {
      this.cards.set(card.messageId, {
        ...card,
        aliases: card.aliases.map((alias) => ({ ...alias }))
      })
    }
  }
  protect(cut: number): void {
    this.protectedThrough = Math.max(this.protectedThrough, cut)
  }
  at(sequence: number): number {
    return this.base + sequence
  }
  observe(sequence: number): void {
    this.clock = Math.max(this.clock, this.at(sequence))
  }

  change(
    messageId: string,
    coordinate: AgentJournalCursor | null,
    present: boolean,
    sequence: number
  ): boolean {
    const cut = this.at(sequence)
    const card = this.cards.get(messageId)
    const prior = card?.aliases.at(-1)
    if (
      prior &&
      prior.present === present &&
      prior.coordinate?.epoch === coordinate?.epoch &&
      prior.coordinate?.sequence === coordinate?.sequence
    ) {
      return false
    }
    if (prior && prior.from > this.protectedThrough) {
      card!.aliases.pop()
    } else if (prior) {
      prior.until = cut
    }
    const alias = { from: cut, coordinate, present }
    if (card) {
      card.aliases.push(alias)
    } else {
      this.cards.set(messageId, { messageId, introduced: cut, aliases: [alias] })
    }
    return true
  }

  releaseHistory(keep: (id: string) => boolean): void {
    this.protectedThrough = -1
    for (const [id, card] of this.cards) {
      if (!keep(id)) {
        this.cards.delete(id)
      } else {
        card.aliases = card.aliases.slice(-1)
      }
    }
  }

  snapshot(
    places: readonly { context: JournalInputContext; original?: AgentJournalCursor }[],
    ids: ReadonlySet<string>
  ): JournalInputLineage {
    const legacy = places.filter((place) => place.context.basis === 'legacy')
    const cuts = legacy.map((place) => place.context.cut).sort((a, b) => a - b)
    const bases = new Map(
      legacy.map(({ context }) => [context.source.epoch, context.cut - context.source.sequence])
    )
    const exact = new Set(
      legacy.flatMap(({ context, original }) =>
        original && original.epoch !== context.source.epoch ? [original.epoch] : []
      )
    )
    const hasCut = (from: number, until: number) => {
      let low = 0,
        high = cuts.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (cuts[mid] < from) {
          low = mid + 1
        } else {
          high = mid
        }
      }
      return low < cuts.length && cuts[low] < until
    }
    const cards: JournalCardLineage[] = []
    for (const card of this.cards.values()) {
      if (!ids.has(card.messageId)) {
        continue
      }
      const aliases = card.aliases.filter(
        (alias) => hasCut(alias.from, alias.until ?? Infinity) || alias === card.aliases.at(-1)
      )
      const normalized: JournalCardAlias[] = []
      for (const alias of aliases) {
        const base = alias.coordinate ? bases.get(alias.coordinate.epoch) : undefined
        const coordinate =
          alias.coordinate &&
          base !== undefined &&
          !exact.has(alias.coordinate.epoch) &&
          alias.coordinate.sequence <= alias.from - base
            ? { ...alias.coordinate, sequence: 0 }
            : alias.coordinate
        const prior = normalized.at(-1)
        if (
          prior &&
          prior.present === alias.present &&
          prior.coordinate?.epoch === coordinate?.epoch &&
          prior.coordinate?.sequence === coordinate?.sequence &&
          !hasCut(prior.until ?? alias.from, alias.from)
        ) {
          prior.until = alias.until
        } else {
          normalized.push({ ...alias, coordinate })
        }
      }
      cards.push({ ...card, aliases: normalized })
    }
    return { clock: this.clock, cards }
  }
}
