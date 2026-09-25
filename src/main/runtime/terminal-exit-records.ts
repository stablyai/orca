import type { TerminalExitRecord } from '../../shared/terminal-surface-exit'

/**
 * Main's in-memory exit record per kept leaf. Deliberately not persisted: after a relaunch a kept
 * leaf spawns a fresh shell. A record dies when its leaf binds a new process, when the surface is
 * closed, or with main.
 */
export class TerminalExitRecords {
  private readonly byLeafId = new Map<string, TerminalExitRecord>()

  constructor(private readonly onChange: (worktreeId: string) => void) {}

  record(record: TerminalExitRecord): void {
    this.byLeafId.set(record.leafId, record)
    this.onChange(record.worktreeId)
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
      this.delete(record)
    }
  }

  clearLeaves(leafIds: Iterable<string>): void {
    for (const leafId of leafIds) {
      const record = this.byLeafId.get(leafId)
      if (record) {
        this.delete(record)
      }
    }
  }

  private delete(record: TerminalExitRecord): void {
    this.byLeafId.delete(record.leafId)
    this.onChange(record.worktreeId)
  }
}
