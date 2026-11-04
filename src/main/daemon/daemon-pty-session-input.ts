import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
import { writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'

export abstract class DaemonPtySessionInput extends DaemonPtySessionSpawn {
  getPtyAvailability(id: string): boolean | null {
    if (
      !this.client.isConnected() ||
      this.sessionsAwaitingDaemonRecovery.has(id) ||
      this.inputClosedIncarnations.isClosed(id, this.ptyInventory.currentIncarnation(id))
    ) {
      return false
    }
    // Inventory includes retained sessions this host has not attached yet.
    return this.activeSessionIds.has(id) || this.ptyInventory.has(id)
  }

  write(id: string, data: string): boolean {
    // Remount recovery cannot reopen a live child's retired PTY master; refuse instead of dropping.
    if (this.inputClosedIncarnations.isClosed(id, this.ptyInventory.currentIncarnation(id))) {
      return false
    }
    const recoverable = this.prepareWrite(id)
    return this.finishWrite(id, this.client.notify('write', { sessionId: id, data }), recoverable)
  }

  /** Preserve ambiguous delivery as a settlement: throwing would look like proven refusal and permit replay. */
  async writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    if (this.inputClosedIncarnations.isClosed(id, this.ptyInventory.currentIncarnation(id))) {
      return writeRefused('provider_refused_write')
    }
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
    // Remount recovery would erase legacy panes that cannot respawn; preserve their readable scrollback.
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

  // Backgrounding is a delivery hint for daemon keep-tail thinning.
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
