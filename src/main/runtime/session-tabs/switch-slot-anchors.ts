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

  record(workspaceId: string, destinationTabId: string, anchor: SlotAnchor): void {
    const entries = this.byWorkspace.get(workspaceId) ?? new Map<string, Entry>()
    entries.set(destinationTabId, { anchor, seen: false, recordedAt: this.now() })
    this.byWorkspace.set(workspaceId, entries)
  }

  forget(workspaceId: string, destinationTabId: string): void {
    this.byWorkspace.get(workspaceId)?.delete(destinationTabId)
  }

  stamp(snapshot: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsSnapshot {
    const entries = this.byWorkspace.get(snapshot.worktree)
    if (!entries) {
      return snapshot
    }
    const present = new Set(snapshot.tabs.map(tabBarId))
    for (const [id, entry] of entries) {
      if (present.has(id)) {
        entry.seen = true
      } else if (entry.seen || this.now() - entry.recordedAt > AGENT_SESSION_SWITCH_HOST_MS) {
        entries.delete(id)
      }
    }
    if (entries.size === 0) {
      this.byWorkspace.delete(snapshot.worktree)
      return snapshot
    }
    return {
      ...snapshot,
      tabs: snapshot.tabs.map((row) => {
        const entry =
          row.type === 'terminal' || row.type === 'agent-session'
            ? entries.get(tabBarId(row))
            : undefined
        return entry && !row.replaces && !row.after ? { ...row, ...entry.anchor } : row
      })
    }
  }
}
