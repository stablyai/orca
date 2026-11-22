import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { watchProcessExit, type ProcessExitWatch } from './native-process-exit-watch'

/** A live PTY that can name the process whose exit ends its foreground. */
export type ForegroundPidSource = {
  readonly isAlive: boolean
  foregroundAgentPid(): number | null
  /** An identity lookup still in flight; it may name an agent the read just missed. */
  pendingForegroundRefresh?(): Promise<unknown> | null
}

// A read naming a stale process can add a pid before the real one is reported; keep a few, never unbounded.
const MAX_WATCHES_PER_PTY = 4

type ForegroundWatch = { watch: ProcessExitWatch; agent: boolean }

/** A foreground that exits or starts without printing leaves no other event; the OS notice is that event, with no timer. */
export class ForegroundExitWatches {
  private readonly watches = new Map<string, Map<number, ForegroundWatch>>()
  /** Reported once per pid until a read shows another, so a group outliving its leader cannot loop. */
  private readonly reportedPids = new Map<string, number>()
  private readonly lookups = new Map<string, symbol>()

  constructor(private readonly onForegroundChange?: (ptyId: string) => void) {}

  /** True when the PTY's agent exit will arrive as a notice; false means only events or reads can show it.
   * identifiedPid is the foreground process a full read proved; a group leader alone may be a wrapper that outlives it. */
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
      return this.isWatching(ptyId, true)
    }
    const agent = Boolean(recognizeAgentProcess(foreground))
    if (!agent) {
      // The pane may still count on an agent notice; tell it to read again and learn it has none.
      if (this.isWatching(ptyId, true)) {
        this.release(ptyId)
        this.onForegroundChange?.(ptyId)
      }
      if (isShellProcess(foreground)) {
        this.release(ptyId)
        return false
      }
    }
    // A command (`sleep 30; codex …`) can hand off to a silent agent; its exit prompts the read that finds it.
    const pid = agent ? (identifiedPid ?? source.foregroundAgentPid()) : (identifiedPid ?? null)
    if (pid === null) {
      return agent && this.isWatching(ptyId, true)
    }
    if (this.reportedPids.get(ptyId) === pid) {
      return false
    }
    if (!this.arm(ptyId, pid, agent)) {
      return false
    }
    return agent
  }

  private arm(ptyId: string, pid: number, agent: boolean): boolean {
    const watches = this.watches.get(ptyId) ?? new Map<number, ForegroundWatch>()
    const existing = watches.get(pid)
    if (existing) {
      existing.agent = agent
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
    watches.set(pid, { watch, agent })
    for (const [oldPid, old] of watches) {
      if (watches.size <= MAX_WATCHES_PER_PTY) {
        break
      }
      old.watch.dispose()
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
        this.onForegroundChange?.(ptyId)
      }
    })
  }

  private isWatching(ptyId: string, agentOnly: boolean): boolean {
    for (const watch of this.watches.get(ptyId)?.values() ?? []) {
      if (!agentOnly || watch.agent) {
        return true
      }
    }
    return false
  }

  private report(ptyId: string, pid: number): void {
    this.watches.get(ptyId)?.delete(pid)
    this.reportedPids.set(ptyId, pid)
    this.onForegroundChange?.(ptyId)
  }

  private release(ptyId: string): void {
    for (const { watch } of this.watches.get(ptyId)?.values() ?? []) {
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
  }
}
