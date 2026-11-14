import { rowsAreObserved, setRowInterest, watchRowInterest } from './ai-vault-row-interest'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
type Observer = (rows: AiVaultScanRows) => void

export class AiVaultScanRowObservers {
  private readonly owners = new Map<Observer, number>()
  private readonly stops = new Map<Observer, () => void>()
  private readonly rows = new Map<string, AiVaultSession>()
  private readonly listeners = new Set<() => void>()
  private observing = false
  private revision = 0
  private closed = false
  constructor(
    private readonly id: string,
    private readonly signal: AbortSignal
  ) {
    setRowInterest(this.publish, {
      observed: () => this.observing,
      subscribe: (changed) => {
        this.listeners.add(changed)
        return () => this.listeners.delete(changed)
      }
    })
  }
  readonly publish = (delta: AiVaultRowDelta): void => {
    if (this.closed || this.signal.aborted || !this.observing) {
      return
    }
    for (const key of delta.removed) {
      this.rows.delete(key)
    }
    for (const row of delta.upserts) {
      this.rows.set(row.id, row)
    }
    const event: AiVaultScanRows = {
      kind: 'delta',
      scanId: this.id,
      revision: ++this.revision,
      delta
    }
    for (const observer of this.owners.keys()) {
      if (rowsAreObserved(observer)) {
        observer(event)
      }
    }
  }
  attach(observer?: Observer): () => void {
    if (!observer) {
      return () => undefined
    }
    this.owners.set(observer, (this.owners.get(observer) ?? 0) + 1)
    if (!this.stops.has(observer)) {
      this.stops.set(observer, watchRowInterest(observer, this.changed))
    }
    this.changed()
    if (this.rows.size && rowsAreObserved(observer)) {
      observer({
        kind: 'snapshot',
        scanId: this.id,
        revision: this.revision,
        sessions: [...this.rows.values()]
      })
    }
    return () => {
      const owners = this.owners.get(observer) ?? 0
      if (owners <= 1) {
        this.owners.delete(observer)
        this.stops.get(observer)?.()
        this.stops.delete(observer)
      } else {
        this.owners.set(observer, owners - 1)
      }
      this.changed()
    }
  }
  dispose(): void {
    this.closed = true
    this.owners.clear()
    for (const stop of this.stops.values()) {
      stop()
    }
    this.stops.clear()
    this.changed()
    this.rows.clear()
    this.listeners.clear()
  }
  private readonly changed = (): void => {
    const observing = !this.closed && [...this.owners.keys()].some(rowsAreObserved)
    if (observing === this.observing) {
      return
    }
    this.observing = observing
    if (!observing) {
      this.rows.clear()
    }
    for (const changed of this.listeners) {
      changed()
    }
  }
}
