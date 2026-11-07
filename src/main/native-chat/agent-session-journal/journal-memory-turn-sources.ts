import type { JournalTurnSourceStorage } from './journal-index-storage'
import {
  compareTurnSources,
  putTurnSource,
  type TurnSource,
  type TurnSourceNode
} from './input-order/journal-newest-turn-tree'

export class MemoryJournalTurnSources implements JournalTurnSourceStorage {
  private root: TurnSourceNode | undefined
  private readonly sources = new Map<string, TurnSource>()

  exportSources(): IterableIterator<[string, TurnSource]> {
    return this.sources.entries()
  }

  get(itemId: string): TurnSource | undefined {
    return this.sources.get(itemId)
  }

  set(itemId: string, source: TurnSource): void {
    const prior = this.sources.get(itemId)
    if (prior && compareTurnSources(prior, source) !== 0) {
      this.root = putTurnSource(this.root, prior, true)
    }
    this.sources.set(itemId, source)
    this.root = putTurnSource(this.root, source, false)
  }

  delete(itemId: string): void {
    const prior = this.sources.get(itemId)
    if (prior) {
      this.sources.delete(itemId)
      this.root = putTurnSource(this.root, prior, true)
    }
  }

  latest(): TurnSource | undefined {
    return this.root?.latest
  }

  anchor(): TurnSource | undefined {
    return this.root?.anchor
  }

  winner(): TurnSource | undefined {
    return this.root?.winner
  }
}
