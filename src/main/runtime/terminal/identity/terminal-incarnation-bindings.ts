import type { PtyIncarnationHandleRecord } from './terminal-handle-records'
import { OrderedTerminalCandidates } from './ordered-terminal-candidates'
type MutableIncarnation = {
  -readonly [K in keyof PtyIncarnationHandleRecord]: PtyIncarnationHandleRecord[K]
}

/** Ordered incarnation aliases and their canonical mutable records share one lifetime. */
export class TerminalIncarnationBindings {
  readonly records = new Map<string, MutableIncarnation>()
  private readonly candidates = new OrderedTerminalCandidates()
  private readonly ownedIncarnations = new WeakMap<PtyIncarnationHandleRecord, MutableIncarnation>()
  constructor(private readonly changed: () => void) {}
  setIncarnation(id: string, input: PtyIncarnationHandleRecord): void {
    const previous = this.records.get(id)
    const owned = { ...input }
    this.ownedIncarnations.set(owned, owned)
    this.records.set(id, owned)
    this.candidates.set(id, owned.handle)
    if (
      !previous ||
      previous.handle !== owned.handle ||
      previous.incarnationId !== owned.incarnationId ||
      previous.leafKey !== owned.leafKey
    ) {
      this.changed()
    }
  }
  setIncarnationLeaf(record: PtyIncarnationHandleRecord, leafKey: string): void {
    const owned = this.ownedIncarnations.get(record)
    if (owned && owned.leafKey !== leafKey) {
      owned.leafKey = leafKey
      this.changed()
    }
  }
  setIncarnationProcess(record: PtyIncarnationHandleRecord, incarnationId: string | null): void {
    const owned = this.ownedIncarnations.get(record)
    if (owned && owned.incarnationId !== incarnationId) {
      owned.incarnationId = incarnationId
      this.changed()
    }
  }
  removeIncarnation(id: string): boolean {
    this.candidates.delete(id)
    const removed = this.records.delete(id)
    if (removed) {
      this.changed()
    }
    return removed
  }
  clearIncarnations(): void {
    this.candidates.clear()
    if (this.records.size > 0) {
      this.records.clear()
      this.changed()
    }
  }
  firstIncarnationPtyId(handle: string): string | undefined {
    return this.candidates.first(handle)
  }
}
