import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import {
  watchProcessExit,
  type ProcessExitWatch
} from '../../pty/process-retirement/native-process-exit-watch'
import type { Session } from '../sessions/session'

/** An agent that exits without printing leaves no other event; the OS exit notice is that event, with no timer. */
export class TerminalHostAgentExitWatches {
  private readonly watches = new Map<string, { pid: number; watch: ProcessExitWatch }>()
  /** Reported once per pid, so a read that still names a dead pid (a group outliving its leader) cannot loop. */
  private readonly reportedPids = new Map<string, number>()

  constructor(private readonly onAgentExit?: (sessionId: string) => void) {}

  /** A read that names an agent watches its process; any other read releases the watch. */
  noteInspection(sessionId: string, session: Session | undefined, foreground: string | null): void {
    if (!session?.isAlive || !recognizeAgentProcess(foreground)) {
      this.release(sessionId)
      return
    }
    const pid = session.foregroundAgentPid()
    if (pid === null) {
      this.release(sessionId)
      return
    }
    if (this.watches.get(sessionId)?.pid === pid || this.reportedPids.get(sessionId) === pid) {
      return
    }
    this.release(sessionId)
    const watch = watchProcessExit(pid, () => this.report(sessionId, pid))
    if (watch === 'gone') {
      this.report(sessionId, pid)
    } else if (watch !== null) {
      this.watches.set(sessionId, { pid, watch })
    }
  }

  private report(sessionId: string, pid: number): void {
    if (this.watches.get(sessionId)?.pid === pid) {
      this.watches.delete(sessionId)
    }
    this.reportedPids.set(sessionId, pid)
    this.onAgentExit?.(sessionId)
  }

  private release(sessionId: string): void {
    this.watches.get(sessionId)?.watch.dispose()
    this.watches.delete(sessionId)
  }

  forget(sessionId: string): void {
    this.release(sessionId)
    this.reportedPids.delete(sessionId)
  }

  dispose(): void {
    for (const { watch } of this.watches.values()) {
      watch.dispose()
    }
    this.watches.clear()
    this.reportedPids.clear()
  }
}
