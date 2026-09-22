import {
  ASSIGNMENT_LIMITS,
  relayHostCloseReasonFrom,
  type RelayHostCloseReason
} from '@orca-cloud/relay-contract'

// Retention matches the dormant assignment TTL: past it the host may have been
// rebalanced onto another cell, so this cell is no longer the one a phone asks.
const RETENTION_MS = ASSIGNMENT_LIMITS.dormantTtlMs
// A fleet-wide auth outage signs out every host at once; the cap bounds that
// burst well above any single cell's host count without becoming a leak.
const MAX_ENTRIES = 50_000

// Why in-memory and not Postgres: a phone reaches the cell its host's assignment
// row already names, which is the same cell that watched the control socket
// close. Losing this on a cell restart degrades to the pre-existing generic
// verdict, so the failure mode is the old behaviour rather than a wrong one.
export class HostCloseReasonMemory {
  private readonly entries = new Map<string, { reason: RelayHostCloseReason; expiresAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  // Silently ignores anything that is not a known reason, which is every close
  // from a host that predates the field and every abrupt 1006.
  record(key: string, reason: unknown): void {
    const parsed = relayHostCloseReasonFrom(reason)
    if (!parsed) {
      return
    }
    this.entries.delete(key)
    this.entries.set(key, { reason: parsed, expiresAt: this.now() + RETENTION_MS })
    this.evict()
  }

  forget(key: string): void {
    this.entries.delete(key)
  }

  read(key: string): RelayHostCloseReason | null {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }
    return entry.reason
  }

  size(): number {
    return this.entries.size
  }

  private evict(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) {
        break
      }
      this.entries.delete(key)
    }
    // Insertion order is recency order (record deletes before setting), so the
    // head is always the oldest survivor.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) {
        break
      }
      this.entries.delete(key)
    }
  }
}
