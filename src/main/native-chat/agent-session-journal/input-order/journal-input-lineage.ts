import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalKeyedMap } from '../journal-keyed-storage'
import type { JournalInputLineageFacts } from '../journal-input-facts-storage'
import { memoryJournalInputLineageFacts } from '../journal-memory-input-facts'

export type JournalInputContext = {
  source: AgentJournalCursor
  basis: 'observed' | 'legacy'
  cut: number
}
export type JournalInputCard = {
  introduced: number
  baseline?: { coordinate: AgentJournalCursor | null }
}
export type JournalCardLineage = JournalInputCard & { messageId: string }
export type JournalInputEntry = { context: JournalInputContext; witnessCardId?: string }
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
  constructor(
    readonly cards: JournalKeyedMap<string, JournalInputCard>,
    private readonly facts: JournalInputLineageFacts = memoryJournalInputLineageFacts(cards)
  ) {}
  get clock(): number {
    return this.facts.clock
  }
  set clock(value: number) {
    this.facts.clock = value
  }

  load(lineage: JournalInputLineage): void {
    this.facts.base = lineage.clock
    this.clock = lineage.clock
    for (const card of lineage.cards) {
      this.cards.set(card.messageId, {
        introduced: card.introduced,
        ...(card.baseline ? { baseline: card.baseline } : {})
      })
    }
  }
  /** A restore stamps cards before its frontier exists, so a reopen starts from no offset too. */
  reopen(): void {
    this.facts.base = 0
  }
  restoreFrontier(sequence: number, entries: JournalKeyedMap<string, JournalInputEntry>): void {
    const frontier = this.facts.frontier(entries)
    this.clock = frontier
    this.facts.base = frontier - sequence
  }
  at(sequence: number): number {
    return this.facts.base + sequence
  }
  observe(sequence: number): void {
    this.clock = Math.max(this.clock, this.at(sequence))
  }

  change(messageId: string, coordinate: AgentJournalCursor | null, sequence: number): void {
    if (!this.cards.has(messageId)) {
      this.cards.set(messageId, {
        introduced: this.at(sequence),
        baseline: { coordinate }
      })
    }
  }
  releaseHistory(keep: (id: string) => boolean): void {
    for (const [id, card] of this.facts.cardsForRelease()) {
      if (!keep(id)) {
        this.cards.delete(id)
      } else {
        delete card.baseline
      }
    }
  }
}
