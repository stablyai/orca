import type { RexFreshSession } from './rex-fresh-session'
import type { IPtyProvider } from '../pty/provider-contract'
import type { PtyDataEvent } from '../pty/events'
import { RexPendingRestores } from './rex-pending-restores'

import { rexPowerLifecycle } from './rex-power-lifecycle'
import { readRexAppliedSize } from './rex-wake-probe'
import { rexTerm } from './rex-fresh-session'
import { checkRexSize } from './rex-fresh-validation'

/** Shared per-provider attachment admission and event state. */
export abstract class RexAttachmentState {
  protected sessions = new Map<string, RexFreshSession>()
  protected restoring = new Set<string>()
  protected pendingRestore = new RexPendingRestores()
  protected dataCallbacks = new Set<(event: PtyDataEvent) => void>()
  protected exitCallbacks = new Set<Parameters<IPtyProvider['onExit']>[0]>()
  protected unavailableCallbacks = new Set<(event: { id: string }) => void>()

  hasPty = (id: string): boolean => this.sessions.has(id)

  onData(callback: (event: PtyDataEvent) => void): () => void {
    this.dataCallbacks.add(callback)
    return () => this.dataCallbacks.delete(callback)
  }

  onExit(callback: Parameters<IPtyProvider['onExit']>[0]): () => void {
    this.exitCallbacks.add(callback)
    return () => this.exitCallbacks.delete(callback)
  }

  onWriteUnavailable(callback: (event: { id: string }) => void): () => void {
    this.unavailableCallbacks.add(callback)
    return () => this.unavailableCallbacks.delete(callback)
  }
  protected notifyWriteUnavailable(id: string): void {
    for (const callback of this.unavailableCallbacks) {
      callback({ id })
    }
  }

  protected abstract markLost(session: RexFreshSession, retainControl?: boolean): void

  async detach(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }
    session.closing = true
    this.pendingRestore.delete(id)
    session.data.close()
    try {
      await session.control.call('session.detach', { session_id: session.sessionId })
    } finally {
      session.control.close()
      this.sessions.delete(id)
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!this.canInteract(session)) {
      return
    }
    checkRexSize(cols, rows)
    void rexTerm(session, 'resize', { columns: cols, rows }).catch(() => this.markLost(session))
  }

  protected canInteract(session: RexFreshSession | undefined): session is RexFreshSession {
    return (
      !!session &&
      !rexPowerLifecycle.isHeld(session) &&
      !session.lost &&
      !session.closing &&
      !this.pendingRestore.has(session.id) &&
      !this.restoring.has(session.id)
    )
  }

  getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    return readRexAppliedSize(this.sessions.get(id))
  }

  getPtyAvailability(id: string): boolean | null {
    const session = this.sessions.get(id)
    return session ? !session.lost && !session.closing && session.exitCode === undefined : null
  }
}
