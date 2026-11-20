import type { OrchestrationDb } from '../../db/orchestration-db'
import type { CrewInvalidation } from '../../crew/crew-changes'

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
      // Why most changes clear all: new Run mail, routing, rebinding and resets all arrive as crew changes.
      this.unsubscribe = db.crewChanges.subscribe((notice) => {
        if (!isNonRunTraffic(notice)) {
          this.byPane.clear()
        }
      })
    }
    let mailboxes = this.byPane.get(paneKey)
    if (!mailboxes) {
      mailboxes = db.runMailboxesWithPointerWorkForPane(paneKey)
      this.byPane.set(paneKey, mailboxes)
    }
    return mailboxes
  }
}

/** Mail between terminals or chats never adds work to a Run mailbox; routing it there notifies separately. */
function isNonRunTraffic(notice: CrewInvalidation | undefined): boolean {
  const addresses = notice?.trafficAddresses
  return (
    !!addresses &&
    notice.size === 1 &&
    notice.has('traffic') &&
    ![...addresses].some((address) => address.startsWith('run:'))
  )
}
