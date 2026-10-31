import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import type { ReplacedTab } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { AGENT_SESSION_SWITCH_HOST_MS } from '../../../shared/agent-session-switch-execution'

type SlotAnchor = { replaces: ReplacedTab } | { after: ReplacedTab }
type Entry = { anchor: SlotAnchor; seen: boolean; recordedAt: number }
type Row = RuntimeMobileSessionTabsSnapshot['tabs'][number]

const tabBarId = (row: Row): string => (row.type === 'terminal' ? row.parentTabId : row.id)

/**
 * Where a switch put its destination, kept in memory for that destination's life. Every frame
 * paired clients get carries it on the destination's rows, so a renderer republish (which never
 * names it) or a renderer frame that lands before main's own write can't expose the destination
 * without it. It dies when the destination's rows leave the snapshot, or when a switch that
 * recorded it never placed the destination.
 */
export class SwitchSlotAnchors {
  private readonly byWorkspace = new Map<string, Map<string, Entry>>()

  constructor(private readonly now: () => number = Date.now) {}

  /** False when the same slot is already recorded for this destination: a retry after a lost
   *  answer keeps the entry its first attempt left, so it can't withdraw an anchor already shown. */
  record(workspaceId: string, destinationTabId: string, anchor: SlotAnchor): boolean {
    const entries = this.byWorkspace.get(workspaceId) ?? new Map<string, Entry>()
    this.byWorkspace.set(workspaceId, entries)
    const existing = entries.get(destinationTabId)
    if (existing && sameSlot(existing.anchor, anchor)) {
      if (!existing.seen) {
        existing.recordedAt = this.now()
      }
      return false
    }
    entries.set(destinationTabId, { anchor, seen: false, recordedAt: this.now() })
    return true
  }

  /** Records the anchor before the write that publishes its destination; a write that fails
   *  withdraws the anchor it added, so a later open isn't stamped into the source's slot. */
  async recordFor<T>(
    workspaceId: string,
    destinationTabId: string,
    anchor: SlotAnchor | undefined,
    write: () => Promise<T>
  ): Promise<T> {
    const recorded = anchor !== undefined && this.record(workspaceId, destinationTabId, anchor)
    try {
      return await write()
    } catch (error) {
      if (recorded) {
        this.forget(workspaceId, destinationTabId)
      }
      throw error
    }
  }

  /** Withdraws an anchor whose destination no frame has shown. */
  forget(workspaceId: string, destinationTabId: string): void {
    const entries = this.byWorkspace.get(workspaceId)
    if (entries?.get(destinationTabId)?.seen === false) {
      entries.delete(destinationTabId)
    }
  }

  /** One pass over the frame's rows, and a new rows array only when a row gains its anchor;
   *  a workspace with no anchor costs nothing. */
  stamp(snapshot: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsSnapshot {
    const entries = this.byWorkspace.get(snapshot.worktree)
    if (!entries) {
      return snapshot
    }
    const present = new Set<string>()
    let tabs: Row[] | undefined
    snapshot.tabs.forEach((row, index) => {
      const id = tabBarId(row)
      const entry = entries.get(id)
      if (!entry) {
        return
      }
      present.add(id)
      entry.seen = true
      if (
        (row.type === 'terminal' || row.type === 'agent-session') &&
        !row.replaces &&
        !row.after
      ) {
        tabs ??= [...snapshot.tabs]
        tabs[index] = { ...row, ...entry.anchor }
      }
    })
    for (const [id, entry] of entries) {
      if (
        !present.has(id) &&
        (entry.seen || this.now() - entry.recordedAt > AGENT_SESSION_SWITCH_HOST_MS)
      ) {
        entries.delete(id)
      }
    }
    if (entries.size === 0) {
      this.byWorkspace.delete(snapshot.worktree)
    }
    return tabs ? { ...snapshot, tabs } : snapshot
  }
}

/** The source's slot when the destination replaces its whole tab, else the place beside it. */
export function slotAnchor(replacedTabId: string | undefined, sourceTabId: string): SlotAnchor {
  return replacedTabId ? { replaces: { tabId: replacedTabId } } : { after: { tabId: sourceTabId } }
}

function sameSlot(a: SlotAnchor, b: SlotAnchor): boolean {
  return 'replaces' in a
    ? 'replaces' in b && a.replaces.tabId === b.replaces.tabId
    : 'after' in b && a.after.tabId === b.after.tabId
}
