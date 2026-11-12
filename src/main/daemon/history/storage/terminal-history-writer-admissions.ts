import { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import { terminalHistoryRoot } from './terminal-history-root'
import type { HistoryWriterAdmission } from './terminal-history-writer-handoff'

/** A writer bound to the admission it was installed under; captured by producers before awaits. */
export type CapturedHistoryWriter = {
  readonly writer: TerminalHistorySessionWriter
  readonly admission: HistoryWriterAdmission
}

/**
 * One manager's writers and open claims on the shared root. A successor's admission closes a
 * claim, detaches its writer synchronously and waits only for work this owner already issued.
 */
export class TerminalHistoryWriterAdmissions {
  readonly writers = new Map<string, CapturedHistoryWriter>()
  // Open claims only; each ends at a successor's handoff or this owner's retirement.
  private readonly admissions = new Map<string, HistoryWriterAdmission>()
  private readonly root
  private readonly unregisterRoot: () => void

  constructor(
    basePath: string,
    private readonly checkpointMaxBytes: number,
    private readonly detach: (sessionId: string) => Promise<void> | undefined
  ) {
    this.root = terminalHistoryRoot(basePath)
    this.unregisterRoot = this.root.registerHost()
  }

  /** Capture before any await; later stale calls hold a permanently closed token. */
  admit(sessionId: string): HistoryWriterAdmission {
    const admission = this.root.admitWriter(sessionId, this, () => this.retireSession(sessionId))
    this.admissions.set(sessionId, admission)
    return admission
  }

  /** This owner's open claim, or a new one only while no other owner holds the ID. */
  claimForCleanup(sessionId: string): HistoryWriterAdmission | undefined {
    const open = this.admissions.get(sessionId)
    if (open?.current()) {
      return open
    }
    const admission = this.root.admitUnclaimedWriter(sessionId, this, () =>
      this.retireSession(sessionId)
    )
    if (admission) {
      this.admissions.set(sessionId, admission)
    }
    return admission
  }

  install(sessionId: string, dir: string, fresh: boolean, admission: HistoryWriterAdmission): void {
    // Both checks: a same-owner replacement writer addresses the same files.
    const entry: CapturedHistoryWriter = {
      writer: new TerminalHistorySessionWriter(
        dir,
        fresh,
        this.checkpointMaxBytes,
        () => admission.current() && this.writers.get(sessionId) === entry
      ),
      admission
    }
    this.writers.set(sessionId, entry)
  }

  /** Restart-dropped or disposed: claims close now and stay fenced until their work settles. */
  retire(): void {
    for (const admission of this.admissions.values()) {
      admission.release()
    }
    this.writers.clear()
    this.unregisterRoot()
  }

  private retireSession(sessionId: string): Promise<void> | undefined {
    this.admissions.delete(sessionId)
    this.writers.delete(sessionId)
    return this.detach(sessionId)
  }
}
