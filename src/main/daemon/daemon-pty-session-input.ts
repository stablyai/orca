import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
import { writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'

export abstract class DaemonPtySessionInput extends DaemonPtySessionSpawn {
  write(id: string, data: string): boolean {
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(id, this.client.notify('write', { sessionId: id, data }), recoverable)
  }

  /**
   * Returns the settlement instead of throwing: the recovery side effects that
   * `finishWrite` performs still run, but an ambiguous notify must not reach the caller
   * as a rejection it would read as a proven refusal.
   */
  async writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    let recoverable: boolean
    try {
      recoverable = this.prepareWrite(id)
    } catch (error) {
      if (error instanceof PtyWriteUnavailableError) {
        // prepareWrite already armed recovery and wrote nothing, so this is proven refusal.
        return writeRefused('endpoint_awaiting_recovery')
      }
      throw error
    }
    const settlement = await this.client.notifyWithSettlement('write', { sessionId: id, data })
    if (settlement.outcome !== 'accepted' && recoverable) {
      this.armWriteRecovery(id)
    }
    return settlement
  }

  protected prepareWrite(id: string): boolean {
    this.markSessionDirty(id)
    // Why recoverable and not just active: rejecting a write asks the pane to remount,
    // which only helps if this endpoint can come back. A legacy adapter has no respawn,
    // so its reattach fails and the pane rebuilds empty — losing scrollback the user
    // could still read. Keep the pre-existing silent drop for those.
    const recoverable =
      this.activeSessionIds.has(id) && !this.respawnAdoptionClosed && Boolean(this.respawnFn)
    if (
      recoverable &&
      (this.sessionsAwaitingDaemonRecovery.has(id) || !this.client.isConnected())
    ) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.reconnectAfterWriteFailure()
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return recoverable
  }

  protected finishWrite(id: string, delivered: boolean, recoverable: boolean): boolean {
    if (!delivered && recoverable) {
      this.armWriteRecovery(id)
      throw new PtyWriteUnavailableError(`Daemon PTY "${id}" is awaiting recovery`)
    }
    return delivered
  }

  protected armWriteRecovery(id: string): void {
    this.sessionsAwaitingDaemonRecovery.add(id)
    this.reconnectAfterWriteFailure()
  }

  resize(id: string, cols: number, rows: number): void {
    this.markSessionDirty(id)
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  pauseProducer(id: string): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.add(id)
    this.client.notify('pausePty', { sessionId: id })
  }

  resumeProducer(id: string): void {
    this.producerResumesOwedOnReconnect.delete(id)
    if (!this.supportsProducerFlowControl) {
      return
    }
    this.pausedProducerSessionIds.delete(id)
    this.client.notify('resumePty', { sessionId: id })
  }

  // Why fire-and-forget (like pausePty): just a delivery hint for the daemon's keep-tail stream thinning.
  setPtyBackgrounded(id: string, background: boolean): void {
    if (!this.supportsProducerFlowControl) {
      return
    }
    // Why: preserved daemons without a sequence-safe, faithful serializer cannot heal a thinned stream.
    // Why also gate on 2031 (#9993): backgrounding is what hands transient-fact scan
    // authority to the daemon. A pre-v29 daemon can announce a 2031 subscribe but never
    // retract it, so a TUI exiting while hidden would strand the subscription and the
    // next theme flip would inject CSI 997 into its replacement shell. Declining to
    // background keeps main's scanner — which emits both facts — authoritative.
    const safeBackground = this.canDelegateBackgroundToDaemon && background
    if (safeBackground) {
      this.backgroundedSessionIds.add(id)
    } else {
      this.backgroundedSessionIds.delete(id)
    }
    this.client.notify('setSessionBackground', { sessionId: id, background: safeBackground })
  }
}
