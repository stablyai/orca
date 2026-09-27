import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalExitRecord } from '../../shared/terminal-surface-exit'

type TerminalExitRecordListeners = {
  /** The desktop renderer's mirror, sent whole on every change. */
  onRecordsChanged: () => void
  /** Republishes the worktree's session tabs so clients see the exit appear or end. */
  onWorktreeChanged: (worktreeId: string) => void
}

type SnapshotTabs = RuntimeMobileSessionTabsSnapshot['tabs']

/**
 * Main's in-memory exit record per kept leaf. Deliberately not persisted: after a relaunch a kept
 * leaf spawns a fresh shell. A record dies when its leaf binds a new process, when its leaf leaves
 * its worktree's stored session-tabs snapshot, or with main.
 */
export class TerminalExitRecords {
  private readonly byLeafId = new Map<string, TerminalExitRecord>()

  constructor(private readonly listeners: TerminalExitRecordListeners) {}

  record(record: TerminalExitRecord): void {
    this.byLeafId.set(record.leafId, record)
    this.listeners.onWorktreeChanged(record.worktreeId)
    this.listeners.onRecordsChanged()
  }

  get(leafId: string): TerminalExitRecord | undefined {
    return this.byLeafId.get(leafId)
  }

  list(): TerminalExitRecord[] {
    return [...this.byLeafId.values()]
  }

  /** A leaf binding a process other than the one that exited has been restarted. */
  releaseForBinding(leafId: string, incarnationId: string | null | undefined): void {
    const record = this.byLeafId.get(leafId)
    if (record && (!incarnationId || record.incarnationId !== incarnationId)) {
      this.byLeafId.delete(leafId)
      this.listeners.onWorktreeChanged(record.worktreeId)
      this.listeners.onRecordsChanged()
    }
  }

  /**
   * Ends the records of leaves in `previous` that `next` no longer lists (a deleted snapshot lists
   * none). Why a diff and not presence: a leaf not published yet must keep its record. Only the
   * mirror is told, because the frame being stored is the publication that removes the leaf.
   */
  releaseDepartedLeaves(previous: SnapshotTabs | undefined, next: SnapshotTabs | undefined): void {
    if (this.byLeafId.size === 0 || !previous) {
      return
    }
    const recordedLeafIds = previous.flatMap((tab) =>
      tab.type === 'terminal' && this.byLeafId.has(tab.leafId) ? [tab.leafId] : []
    )
    if (recordedLeafIds.length === 0) {
      return
    }
    const remaining = new Set(
      (next ?? []).flatMap((tab) => (tab.type === 'terminal' ? [tab.leafId] : []))
    )
    let changed = false
    for (const leafId of recordedLeafIds) {
      if (!remaining.has(leafId)) {
        changed = this.byLeafId.delete(leafId) || changed
      }
    }
    if (changed) {
      this.listeners.onRecordsChanged()
    }
  }
}
