import type { OrchestrationDb } from '../../db/orchestration-db'
import type { CrewInvalidation } from '../../crew/crew-changes'
import { paneKeyMatchSuffix } from '../../db/pane-key-match'

/** Each pane's Run mailboxes that owe pointer work, until a change that could add some.
 * Why: held-mail retries ask on a timer, and the query visits every Run ever bound to the pane. */
export class PaneRunMailCache {
  private db: OrchestrationDb | null = null
  private unsubscribe: (() => void) | null = null
  /** Keyed by the pane's match suffix, which the query and Run binding both use. */
  private readonly bySuffix = new Map<string, string[]>()

  read(db: OrchestrationDb, paneKey: string): string[] {
    // Why uncached without the bus: nothing would tell the cache that new mail arrived.
    if (!db.crewChanges) {
      return db.runMailboxesWithPointerWorkForPane?.(paneKey) ?? []
    }
    if (db !== this.db) {
      this.unsubscribe?.()
      this.bySuffix.clear()
      this.db = db
      this.unsubscribe = db.crewChanges.subscribe((notice) => this.invalidate(db, notice))
    }
    const suffix = paneKeyMatchSuffix(paneKey)
    const cached = this.bySuffix.get(suffix)
    if (!cached) {
      const mailboxes = db.runMailboxesWithPointerWorkForPane(paneKey)
      this.bySuffix.set(suffix, mailboxes)
      return mailboxes
    }
    if (cached.length === 0) {
      return cached
    }
    // Why: reading mail sends no crew change, so drop mailboxes whose work is gone in one indexed query.
    const live = db.getMailboxesWithPointerWork(cached)
    if (live.size === cached.length) {
      return cached
    }
    const remaining = cached.filter((mailbox) => live.has(mailbox))
    this.bySuffix.set(suffix, remaining)
    return remaining
  }

  /** A retired terminal's pane holds no entry; a pane that returns only queries again. */
  forget(paneKey: string): void {
    this.bySuffix.delete(paneKeyMatchSuffix(paneKey))
  }

  /** New mail to a Run touches only its coordinator's pane; any other change (routing, rebinding, resets) clears all. */
  private invalidate(db: OrchestrationDb, notice: CrewInvalidation): void {
    const addresses = notice.trafficAddresses
    if (!addresses || notice.size !== 1 || !notice.has('traffic')) {
      this.bySuffix.clear()
      return
    }
    for (const address of addresses) {
      if (!address.startsWith('run:')) {
        continue
      }
      const paneKey = db.getRun(address.slice('run:'.length))?.coordinator_pane_key
      if (!paneKey) {
        this.bySuffix.clear()
        return
      }
      this.bySuffix.delete(paneKeyMatchSuffix(paneKey))
    }
  }
}
