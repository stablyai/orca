import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'

export type JournalInputContext = {
  source: AgentJournalCursor
  basis: 'observed' | 'legacy'
  cut: number
}
export type JournalCardLineage = {
  messageId: string
  introduced: number
  baseline?: { coordinate: AgentJournalCursor | null }
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
      card.introduced > clock
    ) {
      return false
    }
    ids.add(card.messageId)
    return (
      card.baseline === undefined ||
      (object(card.baseline) &&
        (card.baseline.coordinate === null || isInputCoordinate(card.baseline.coordinate)))
    )
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

/** Initial source coordinates and introduction cuts never follow physical restatement rows. */
export class JournalInputLineageOwner {
  readonly cards = new Map<string, JournalCardLineage>()
  private base = 0
  clock = 0

  load(lineage: JournalInputLineage): void {
    this.base = lineage.clock
    this.clock = lineage.clock
    for (const card of lineage.cards) {
      this.cards.set(card.messageId, { ...card })
    }
  }
  at(sequence: number): number {
    return this.base + sequence
  }
  observe(sequence: number): void {
    this.clock = Math.max(this.clock, this.at(sequence))
  }

  change(messageId: string, coordinate: AgentJournalCursor | null, sequence: number): void {
    if (!this.cards.has(messageId)) {
      this.cards.set(messageId, {
        messageId,
        introduced: this.at(sequence),
        baseline: { coordinate }
      })
    }
  }
  releaseHistory(keep: (id: string) => boolean): void {
    for (const [id, card] of this.cards) {
      if (!keep(id)) {
        this.cards.delete(id)
      } else {
        delete card.baseline
      }
    }
  }
  snapshot(
    places: readonly { context: JournalInputContext }[],
    ids: ReadonlySet<string>
  ): JournalInputLineage {
    const legacy = places.some((place) => place.context.basis === 'legacy')
    const cards: JournalCardLineage[] = []
    for (const card of this.cards.values()) {
      if (ids.has(card.messageId)) {
        cards.push({
          messageId: card.messageId,
          introduced: card.introduced,
          ...(legacy && card.baseline ? { baseline: card.baseline } : {})
        })
      }
    }
    return { clock: this.clock, cards }
  }
}
