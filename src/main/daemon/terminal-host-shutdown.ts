import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import type { Session } from './session'

export type ShutdownCallbacks = {
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
}

const DEFAULT_MAX_TOMBSTONES = 1000

/** Owns TerminalHost's teardown surface: killed-session tombstones, final
 *  checkpoints, the bounded graceful drain, and force-kill disposal. */
export class TerminalHostShutdown {
  private sessions: Map<string, Session>
  private killedTombstones = new Map<string, number>()
  private maxTombstones: number
  private onFinalCheckpoint: ShutdownCallbacks['onFinalCheckpoint']

  constructor(
    sessions: Map<string, Session>,
    opts: { maxTombstones?: number; onFinalCheckpoint?: ShutdownCallbacks['onFinalCheckpoint'] }
  ) {
    this.sessions = sessions
    this.maxTombstones = opts.maxTombstones ?? DEFAULT_MAX_TOMBSTONES
    this.onFinalCheckpoint = opts.onFinalCheckpoint
  }

  recordTombstone(sessionId: string): void {
    this.killedTombstones.delete(sessionId)
    this.killedTombstones.set(sessionId, Date.now())
    if (this.killedTombstones.size > this.maxTombstones) {
      const oldest = this.killedTombstones.keys().next().value
      if (oldest) {
        this.killedTombstones.delete(oldest)
      }
    }
  }

  clearTombstone(sessionId: string): void {
    this.killedTombstones.delete(sessionId)
  }

  isKilled(sessionId: string): boolean {
    return this.killedTombstones.has(sessionId)
  }

  private writeFinalCheckpoints(opts: { dirtyOnly?: boolean } = {}): void {
    // Why: written before killing so graceful shutdown has zero data loss;
    // the checkpoint callback writes synchronously to disk.
    if (this.onFinalCheckpoint) {
      for (const [sessionId, session] of this.sessions) {
        if (!session.isAlive) {
          continue
        }
        if (opts.dirtyOnly && !session.hasPendingOutputForCheckpoint()) {
          continue
        }
        const take = session.takePendingOutput(true, { teardownSnapshot: true })
        if (take?.snapshot) {
          try {
            this.onFinalCheckpoint(sessionId, take.snapshot, take.records)
          } catch {
            // Best-effort — don't block shutdown
          }
        }
      }
    }
  }

  private hasLiveSessions(): boolean {
    for (const [, session] of this.sessions) {
      if (session.isAlive) {
        return true
      }
    }
    return false
  }

  async drainLiveSessions(drainMs: number): Promise<void> {
    this.writeFinalCheckpoints()
    for (const [, session] of this.sessions) {
      // Why: daemon shutdown must not fan exit events to connected apps —
      // restartDaemon and external-termination recovery rely on sessions dying
      // silently so history meta keeps endedAt=null for cold restore.
      session.detachAllClients()
    }
    let anyLive = false
    for (const [, session] of this.sessions) {
      if (session.isAlive && !session.isTerminating) {
        session.kill()
      }
      anyLive ||= session.isAlive
    }
    if (!anyLive) {
      return
    }
    const deadline = Date.now() + drainMs
    while (Date.now() < deadline) {
      if (!this.hasLiveSessions()) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  dispose(): void {
    this.writeFinalCheckpoints()
    for (const [, session] of this.sessions) {
      session.detachAllClients()
      // Why: SIGKILL on an already-exited session would target a reaped pid
      // that POSIX can recycle to a stranger; dead sessions only release the
      // ptmx fd via disposeSubprocess(). See docs/fix-pty-fd-leak.md.
      if (session.isAlive) {
        session.forceKillAndDisposeSubprocess()
      } else {
        session.disposeSubprocess()
      }
    }
    this.sessions.clear()
    this.killedTombstones.clear()
  }

  async disposeAndWaitForForceKill(opts: { checkpointDirtyOnly?: boolean } = {}): Promise<void> {
    this.writeFinalCheckpoints({ dirtyOnly: opts.checkpointDirtyOnly === true })
    const pendingForceKills: Promise<void>[] = []
    for (const [, session] of this.sessions) {
      session.detachAllClients()
      if (session.isAlive) {
        pendingForceKills.push(session.forceKillAndDisposeSubprocessAndWait())
      } else {
        session.disposeSubprocess()
      }
    }
    await Promise.all(pendingForceKills)
    this.sessions.clear()
    this.killedTombstones.clear()
  }
}
