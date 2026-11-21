import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import { watchProcessExit, type ProcessExitWatch } from './native-process-exit-watch'

/** A live PTY that can name the process whose exit ends its foreground agent. */
export type ForegroundAgentPidSource = {
  readonly isAlive: boolean
  foregroundAgentPid(): number | null
}

// A read naming a stale agent can add a pid before the real one is reported; keep a few, never unbounded.
const MAX_WATCHES_PER_PTY = 4

/** An agent that exits without printing leaves no other event; the OS exit notice is that event, with no timer. */
export class ForegroundAgentExitWatches {
  private readonly watches = new Map<string, Map<number, ProcessExitWatch>>()
  /** Reported once per pid until a read shows a non-agent, so a group outliving its leader cannot loop. */
  private readonly reportedPids = new Map<string, number>()

  constructor(private readonly onAgentExit?: (ptyId: string) => void) {}

  /** True when the PTY's agent exit will arrive as a notice; false means only events or reads can show it.
   * identifiedPid is the agent process a full read proved; a group leader alone may be a wrapper that outlives it. */
  noteInspection(
    ptyId: string,
    source: ForegroundAgentPidSource | undefined,
    foreground: string | null,
    identifiedPid?: number
  ): boolean {
    if (!source?.isAlive) {
      this.forget(ptyId)
      return false
    }
    // An unverifiable read proves nothing; keep what is watched.
    if (foreground === null) {
      return this.isWatching(ptyId)
    }
    if (!recognizeAgentProcess(foreground)) {
      const wasWatching = this.isWatching(ptyId)
      this.forget(ptyId)
      // The pane may still count on a notice; tell it to read again and learn it has none.
      if (wasWatching) {
        this.onAgentExit?.(ptyId)
      }
      return false
    }
    const pid = identifiedPid ?? source.foregroundAgentPid()
    if (pid === null) {
      return this.isWatching(ptyId)
    }
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

  private isWatching(ptyId: string): boolean {
    return (this.watches.get(ptyId)?.size ?? 0) > 0
  }

  private report(ptyId: string, pid: number): void {
    this.watches.get(ptyId)?.delete(pid)
    this.reportedPids.set(ptyId, pid)
    this.onAgentExit?.(ptyId)
  }

  forget(ptyId: string): void {
    for (const watch of this.watches.get(ptyId)?.values() ?? []) {
      watch.dispose()
    }
    this.watches.delete(ptyId)
    this.reportedPids.delete(ptyId)
  }

  dispose(): void {
    for (const ptyId of this.watches.keys()) {
      this.forget(ptyId)
    }
    this.reportedPids.clear()
  }
}
