import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import { watchProcessExit, type ProcessExitWatch } from './native-process-exit-watch'

/** A live PTY that can name the process whose exit ends its foreground agent. */
export type ForegroundPidSource = {
  readonly isAlive: boolean
  foregroundAgentPid(): number | null
  /** An identity lookup still in flight; it may name an agent the read just missed. */
  pendingForegroundRefresh?(): Promise<unknown> | null
}

// A read naming a stale agent can add a pid before the real one is reported; keep a few, never unbounded.
const MAX_WATCHES_PER_PTY = 4

/** An agent that exits, or that a late lookup names, without printing leaves no other event; this notice is that event, with no timer. */
export class ForegroundExitWatches {
  private readonly watches = new Map<string, Map<number, ProcessExitWatch>>()
  /** Reported once per pid until a read shows a non-agent, so a group outliving its leader cannot loop. */
  private readonly reportedPids = new Map<string, number>()
  private readonly lookups = new Map<string, symbol>()
  /** The agent the last proven read named; a read without a pid may lean on its watch only while it names the same agent. */
  private readonly current = new Map<string, { name: string; pid: number }>()

  constructor(private readonly onAgentChange?: (ptyId: string) => void) {}

  /** True when the PTY's agent exit will arrive as a notice; false means only events or reads can show it.
   * identifiedPid is the agent process a full read proved; a group leader alone may be a wrapper that outlives it. */
  noteInspection(
    ptyId: string,
    source: ForegroundPidSource | undefined,
    foreground: string | null,
    identifiedPid?: number
  ): boolean {
    if (!source?.isAlive) {
      this.forget(ptyId)
      return false
    }
    this.noticeLookup(ptyId, source)
    // An unverifiable read proves nothing; keep what is watched.
    if (foreground === null) {
      return this.isWatching(ptyId)
    }
    if (!recognizeAgentProcess(foreground)) {
      const wasWatching = this.isWatching(ptyId)
      this.release(ptyId)
      // The pane may still count on a notice; tell it to read again and learn it has none.
      if (wasWatching) {
        this.onAgentChange?.(ptyId)
      }
      return false
    }
    const pid = identifiedPid ?? source.foregroundAgentPid()
    if (pid === null) {
      const current = this.current.get(ptyId)
      return current?.name === foreground && this.watches.get(ptyId)?.has(current.pid) === true
    }
    this.current.set(ptyId, { name: foreground, pid })
    if (this.reportedPids.get(ptyId) === pid) {
      return false
    }
    const watches = this.watches.get(ptyId) ?? new Map<number, ProcessExitWatch>()
    if (watches.has(pid)) {
      return true
    }
    const watch = watchProcessExit(pid, () => this.report(ptyId, pid))
    if (watch === 'gone') {
      this.report(ptyId, pid)
      return false
    }
    if (watch === null) {
      return false
    }
    watches.set(pid, watch)
    for (const [oldPid, oldWatch] of watches) {
      if (watches.size <= MAX_WATCHES_PER_PTY) {
        break
      }
      oldWatch.dispose()
      watches.delete(oldPid)
    }
    this.watches.set(ptyId, watches)
    return true
  }

  /** A lookup that lands after the read returned can name a new agent; announce it once, from the lookup itself. */
  private noticeLookup(ptyId: string, source: ForegroundPidSource): void {
    const pending = source.pendingForegroundRefresh?.()
    if (!pending || this.lookups.has(ptyId)) {
      return
    }
    const token = Symbol(ptyId)
    this.lookups.set(ptyId, token)
    const before = source.foregroundAgentPid()
    void pending.then(() => {
      if (this.lookups.get(ptyId) !== token) {
        return
      }
      this.lookups.delete(ptyId)
      const pid = source.foregroundAgentPid()
      if (
        source.isAlive &&
        pid !== null &&
        pid !== before &&
        !this.watches.get(ptyId)?.has(pid) &&
        this.reportedPids.get(ptyId) !== pid
      ) {
        this.onAgentChange?.(ptyId)
      }
    })
  }

  private isWatching(ptyId: string): boolean {
    return (this.watches.get(ptyId)?.size ?? 0) > 0
  }

  private report(ptyId: string, pid: number): void {
    this.watches.get(ptyId)?.delete(pid)
    this.reportedPids.set(ptyId, pid)
    this.onAgentChange?.(ptyId)
  }

  private release(ptyId: string): void {
    this.current.delete(ptyId)
    for (const watch of this.watches.get(ptyId)?.values() ?? []) {
      watch.dispose()
    }
    this.watches.delete(ptyId)
    this.reportedPids.delete(ptyId)
  }

  forget(ptyId: string): void {
    this.release(ptyId)
    this.lookups.delete(ptyId)
  }

  dispose(): void {
    for (const ptyId of this.watches.keys()) {
      this.forget(ptyId)
    }
    this.reportedPids.clear()
    this.lookups.clear()
    this.current.clear()
  }
}
