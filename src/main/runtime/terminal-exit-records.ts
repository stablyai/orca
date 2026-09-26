import type { TerminalExitRecord } from '../../shared/terminal-surface-exit'

type TerminalExitRecordListeners = {
  /** The desktop renderer's mirror, sent whole on every change. */
  onRecordsChanged: () => void
  /** Republishes the worktree's session tabs so clients see the exit appear or end. */
  onWorktreeChanged: (worktreeId: string) => void
}

/**
 * Main's in-memory exit record per kept leaf. Deliberately not persisted: after a relaunch a kept
 * leaf spawns a fresh shell. A record dies when its leaf binds a new process, when the surface is
 * closed, or with main.
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
   * Ends the records of leaves a close removed. The close's own publication carries the cleared
   * record with the removal; republishing here would first show the closed leaf without its exit.
   */
  clearClosedLeaves(leafIds: Iterable<string>): void {
    let changed = false
    for (const leafId of leafIds) {
      changed = this.byLeafId.delete(leafId) || changed
    }
    if (changed) {
      this.listeners.onRecordsChanged()
    }
  }
}
