import { randomUUID } from 'node:crypto'
import { formatPanePresentationToken } from '../../shared/terminal-pane-presentation-token'

type Stamp = { revision: number; changedAtMs: number }

// Why bounded: entries exist only for tabs a client switched; evicting one only re-fences it.
const MAX_TRACKED_TABS = 1_024

/**
 * A headless host's presentation intents per tab: advanced only by an accepted client switch
 * (same value included), never by the exit's own write, hint clears or layout pushes. A pane's
 * token also carries the PTY its published row is bound to. In memory only; a restart starts a
 * new epoch.
 */
export class HeadlessPresentationStamps {
  private readonly epoch = randomUUID().slice(0, 8)
  private readonly stamps = new Map<string, Stamp>()

  private key(worktreeId: string, tabId: string): string {
    return `${worktreeId}\0${tabId}`
  }

  bump(worktreeId: string, tabId: string, nowMs = Date.now()): void {
    const key = this.key(worktreeId, tabId)
    const current = this.stamps.get(key)
    this.stamps.delete(key)
    this.stamps.set(key, {
      revision: (current?.revision ?? 0) + 1,
      changedAtMs: Math.max(nowMs, current?.changedAtMs ?? 0)
    })
    if (this.stamps.size > MAX_TRACKED_TABS) {
      const oldest = this.stamps.keys().next().value
      if (oldest !== undefined) {
        this.stamps.delete(oldest)
      }
    }
  }

  read(worktreeId: string, tabId: string): Stamp {
    return this.stamps.get(this.key(worktreeId, tabId)) ?? { revision: 0, changedAtMs: 0 }
  }

  token(worktreeId: string, tabId: string, boundPtyId: string | null | undefined): string {
    return formatPanePresentationToken(
      this.epoch,
      this.read(worktreeId, tabId).revision,
      boundPtyId
    )
  }
}
