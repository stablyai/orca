import { finishJournalStepsAsync, sortJournalSteps } from './journal-reconstruction-steps'
import { journalInputOrder } from './journal-input-order-owner'
import type { JournalReducerState } from './journal-reducer'
import type { LegacyQueuedCards } from './journal-queue-import'
import type { QueuedMessageRow } from './queued-message-table'

/** Prepared queue order is keyed by the canonical owner as well as its revision. */
export class JournalQueuedMessageList {
  private readonly viewed = new WeakMap<
    JournalReducerState,
    { key: string; cards: readonly QueuedMessageRow[] }
  >()
  constructor(
    private readonly legacy: LegacyQueuedCards,
    private readonly state: () => JournalReducerState,
    private readonly current: () => JournalReducerState
  ) {}
  private key(state: JournalReducerState): string {
    return `${state.epoch}:${state.queue.revision}:${journalInputOrder(state).cardVersion(state)}:${this.legacy.key(state)}`
  }
  list(): readonly QueuedMessageRow[] {
    const state = this.state()
    const key = this.key(state)
    let viewed = this.viewed.get(state)
    if (viewed?.key !== key) {
      const cards = [...journalInputOrder(state).liveCards(state)]
      viewed = { key, cards: cards.sort((a, b) => a.position - b.position) }
      this.viewed.set(state, viewed)
    }
    return viewed.cards
  }

  async listAsync(state = this.current()): Promise<readonly QueuedMessageRow[]> {
    const order = journalInputOrder(state)
    const legacy = await this.legacy.cardsAsync(state)
    await finishJournalStepsAsync(order.overlaySteps(state, legacy))
    await finishJournalStepsAsync(order.cards.ensureSteps(state))
    const key = `${state.epoch}:${state.queue.revision}:${order.cardVersion(state)}:${this.legacy.key(state)}`
    let viewed = this.viewed.get(state)
    if (viewed?.key !== key) {
      const cards = await finishJournalStepsAsync(
        sortJournalSteps(order.cards.live(), (a, b) => a.position - b.position)
      )
      viewed = { key, cards }
      this.viewed.set(state, viewed)
    }
    await this.legacy.preparePublication(state)
    return viewed.cards
  }
}
