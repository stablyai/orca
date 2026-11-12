import { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import { terminalHistoryRoot } from './terminal-history-root'
import type { HistoryWriterAdmission } from './terminal-history-writer-handoff'

/** A writer bound to the admission it was installed under; captured by producers before awaits. */
export type CapturedHistoryWriter = {
  readonly writer: TerminalHistorySessionWriter
  readonly admission: HistoryWriterAdmission
}

const CLOSED_ADMISSION: HistoryWriterAdmission = {
  ready: Promise.resolve(),
  isReady: () => true,
  current: () => false,
  release: () => {}
}

/**
 * One manager's writers and open claims on the shared root. A successor's admission closes a
 * claim, detaches its writer synchronously and waits only for work this owner already issued.
 */
export class TerminalHistoryWriterAdmissions {
  readonly writers = new Map<string, CapturedHistoryWriter>()
  // Open claims only; each ends at a successor's handoff or this owner's retirement.
  private readonly admissions = new Map<string, HistoryWriterAdmission>()
  // In-flight operations on a claim; with no writer and no hold, the claim has nothing to fence.
  private readonly holds = new Map<string, { admission: HistoryWriterAdmission; count: number }>()
  private retired = false
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
    if (this.retired) {
      // A late producer of a retired owner never takes the ID back from a successor.
      return CLOSED_ADMISSION
    }
    const admission = this.root.admitWriter(sessionId, this, () => this.retireSession(sessionId))
    this.admissions.set(sessionId, admission)
    return admission
  }

  /** An operation's claim, kept until `drop`; after that only an installed writer keeps it. */
  hold(sessionId: string): HistoryWriterAdmission {
    const admission = this.admit(sessionId)
    const held = this.holds.get(sessionId)
    if (admission.current()) {
      this.holds.set(sessionId, {
        admission,
        count: held?.admission === admission ? held.count + 1 : 1
      })
    }
    return admission
  }

  drop(sessionId: string, admission: HistoryWriterAdmission | undefined, releaseIdle = true): void {
    const held = this.holds.get(sessionId)
    if (!held || held.admission !== admission) {
      return
    }
    held.count -= 1
    if (held.count === 0) {
      this.holds.delete(sessionId)
    }
    if (releaseIdle) {
      this.releaseIdle(sessionId)
    }
  }

  releaseUnheld(sessionId: string, admission: HistoryWriterAdmission): void {
    if (this.holds.get(sessionId)?.admission !== admission) {
      admission.release()
    }
  }

  /** Exact owner only: a successor's claim is never in this map, and a live writer keeps ours. */
  releaseIdle(sessionId: string): void {
    if (!this.holds.has(sessionId) && !this.writers.has(sessionId)) {
      this.admissions.get(sessionId)?.release()
    }
  }

  /** This owner's open claim, or a new one only while no other owner holds the ID. */
  claimForCleanup(sessionId: string): HistoryWriterAdmission | undefined {
    if (this.retired) {
      return undefined
    }
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
    this.retired = true
    this.holds.clear()
    for (const admission of this.admissions.values()) {
      admission.release()
    }
    this.writers.clear()
    this.unregisterRoot()
  }

  private retireSession(sessionId: string): Promise<void> | undefined {
    this.admissions.delete(sessionId)
    this.holds.delete(sessionId)
    this.writers.delete(sessionId)
    return this.detach(sessionId)
  }
}
