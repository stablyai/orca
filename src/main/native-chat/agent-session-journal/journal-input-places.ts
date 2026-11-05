import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'
import type { InputPlaceQuery } from './journal-input-place-index'
import { JournalInputEvidence } from './journal-input-evidence'
import { JournalInputLineageOwner } from './journal-input-lineage'
import { JournalInputCardIndex } from './journal-input-card-index'
import {
  readJournalInputPlace,
  journalInputsNeedingAcceptance,
  journalInputAcceptanceIdsSteps
} from './journal-input-order-state'

export class JournalInputPlaces extends JournalInputEvidence {
  protected readonly originals = new Map<string, AgentJournalCursor | undefined>()
  readonly lineage: JournalInputLineageOwner
  readonly cards: JournalInputCardIndex
  constructor(
    state: JournalReducerState,
    protected originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ) {
    super(state)
    this.lineage = new JournalInputLineageOwner(state.inputCards)
    this.cards = new JournalInputCardIndex(this.lineage)
  }
  withAcceptance<T>(read: (id: string) => AgentJournalCursor | undefined, run: () => T): T {
    const previous = this.originalAcceptance
    this.originalAcceptance = read
    try {
      return run()
    } finally {
      this.originalAcceptance = previous
    }
  }

  needsAcceptance(ids: readonly string[]): string[] {
    return journalInputsNeedingAcceptance(this.state, this.originals, ids)
  }
  acceptanceIdsSteps(): Generator<void, string[]> {
    return journalInputAcceptanceIdsSteps(this.state, this.originals)
  }

  place(id: string): ReturnType<typeof readJournalInputPlace> {
    return readJournalInputPlace(this.state, id, this.originals, this.originalAcceptance)
  }
  liveCards(state: JournalReducerState): Iterable<QueuedMessageRow> {
    this.cards.ensure(state)
    return this.cards.live()
  }
  cardVersion(state: JournalReducerState): number {
    this.cards.ensure(state)
    return this.cards.version()
  }
  cardBounds(state: JournalReducerState): { first: number; last: number } {
    this.cards.ensure(state)
    return this.cards.bounds()
  }
  head(state: JournalReducerState, floor: AgentJournalCursor | null): QueuedMessageRow | undefined {
    this.cards.ensure(state, floor)
    return this.cards.head()
  }
  paused(
    state: JournalReducerState,
    card: QueuedMessageRow,
    floor: AgentJournalCursor | null
  ): boolean {
    this.cards.ensure(state, floor)
    return this.cards.paused(card)
  }

  predecessors(state: JournalReducerState, id: string): InputPlaceQuery {
    this.cards.ensure(state)
    const place = this.place(id)
    return place?.witnessCardId ? this.cards.query(place) : { position: -Infinity }
  }

  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    const place = this.place(submission.clientMessageId)
    return Boolean(place?.witnessCardId && this.cards.relation(card, place))
  }
}
