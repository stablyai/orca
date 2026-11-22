import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import { watchProcessExit, type ProcessExitWatch } from './native-process-exit-watch'

/** A live PTY that can name the process whose exit ends its foreground agent. */
export type ForegroundPidSource = {
  readonly isAlive: boolean
  foregroundAgent(): { processName: string; pid: number; identifiedAt?: number } | null
  /** An identity lookup still in flight; it may name an agent the read just missed. */
  pendingForegroundRefresh?(): Promise<unknown> | null
}

/** The agent a read named, for a check that the watched pid still belongs to it (a pid can be recycled):
 * its start marker from a full capture, or a time no earlier than its creation. */
export type ForegroundAgentIdentity = {
  processName: string
  startTime?: string
  identifiedAt?: number
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
  /** One re-read notice per cached pid a stale read disagreed with, so a lagging cache cannot loop. */
  private readonly mismatchedPids = new Map<string, number>()

  constructor(
    private readonly onAgentChange?: (ptyId: string) => void,
    private readonly isSameAgent?: (
      pid: number,
      expected: ForegroundAgentIdentity
    ) => Promise<boolean>
  ) {}

  /** True when the PTY's agent exit will arrive as a notice; false means only events or reads can show it.
   * identifiedPid is the agent process a full read proved; a group leader alone may be a wrapper that outlives it. */
  noteInspection(
    ptyId: string,
    source: ForegroundPidSource | undefined,
    foreground: string | null,
    identifiedPid?: number,
    identifiedStartTime?: string
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
    const recognized = recognizeAgentProcess(foreground)
    if (!recognized) {
      const wasWatching = this.isWatching(ptyId)
      this.release(ptyId)
      // The pane may still count on a notice; tell it to read again and learn it has none.
      if (wasWatching) {
        this.onAgentChange?.(ptyId)
      }
      return false
    }
    const cached = identifiedPid === undefined ? source.foregroundAgent() : null
    // A lookup that landed after the read named its agent: the pid is another agent's, so read again.
    if (cached && recognizeAgentProcess(cached.processName)?.agent !== recognized.agent) {
      if (this.mismatchedPids.get(ptyId) !== cached.pid) {
        this.mismatchedPids.set(ptyId, cached.pid)
        this.onAgentChange?.(ptyId)
      }
      return false
    }
    const pid = identifiedPid ?? cached?.pid ?? null
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
    this.confirmIdentity(ptyId, pid, watch, {
      processName: foreground,
      startTime: identifiedStartTime,
      identifiedAt: cached?.identifiedAt
    })
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

  /** The agent may have exited and its pid been reused before the watch was armed; then the watch proves nothing. */
  private confirmIdentity(
    ptyId: string,
    pid: number,
    watch: ProcessExitWatch,
    expected: ForegroundAgentIdentity
  ): void {
    if (!this.isSameAgent) {
      return
    }
    void this.isSameAgent(pid, expected)
      .catch(() => false)
      .then((same) => {
        if (same || this.watches.get(ptyId)?.get(pid) !== watch) {
          return
        }
        watch.dispose()
        this.watches.get(ptyId)?.delete(pid)
        // Never re-arm this pid; the pane keeps its slow re-check until a read names another.
        this.reportedPids.set(ptyId, pid)
        this.onAgentChange?.(ptyId)
      })
  }

  /** A lookup that lands after the read returned can name a new agent; announce it once, from the lookup itself. */
  private noticeLookup(ptyId: string, source: ForegroundPidSource): void {
    const pending = source.pendingForegroundRefresh?.()
    if (!pending || this.lookups.has(ptyId)) {
      return
    }
    const token = Symbol(ptyId)
    this.lookups.set(ptyId, token)
    const before = source.foregroundAgent()?.pid ?? null
    void pending.then(() => {
      if (this.lookups.get(ptyId) !== token) {
        return
      }
      this.lookups.delete(ptyId)
      const pid = source.foregroundAgent()?.pid ?? null
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
    this.mismatchedPids.delete(ptyId)
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
    this.mismatchedPids.clear()
  }
}
