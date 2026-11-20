import type { OrchestrationDb } from '../../db/orchestration-db'

/** Each pane's Run mailboxes that owe pointer work, until the next crew change.
 * Why: held-mail retries ask on a timer, and the query visits every Run ever bound to the pane. */
export class PaneRunMailCache {
  private db: OrchestrationDb | null = null
  private unsubscribe: (() => void) | null = null
  private readonly byPane = new Map<string, string[]>()

  read(db: OrchestrationDb, paneKey: string): string[] {
    // Why uncached without the bus: nothing would tell the cache that new mail arrived.
    if (!db.crewChanges) {
      return db.runMailboxesWithPointerWorkForPane?.(paneKey) ?? []
    }
    if (db !== this.db) {
      this.unsubscribe?.()
      this.byPane.clear()
      this.db = db
      // Why any change clears all: new mail, rebinding and resets all arrive as crew changes.
      this.unsubscribe = db.crewChanges.subscribe(() => this.byPane.clear())
    }
    let mailboxes = this.byPane.get(paneKey)
    if (!mailboxes) {
      mailboxes = db.runMailboxesWithPointerWorkForPane(paneKey)
      this.byPane.set(paneKey, mailboxes)
    }
    return mailboxes
  }
}
