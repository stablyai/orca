import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { DaemonPtySessionInventory } from './daemon-pty-session-inventory'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
import type { PtyBackgroundStreamEvent } from '../providers/types'

export abstract class DaemonPtyEventSubscriptions extends DaemonPtySessionInventory {
  onData(
    callback: (payload: {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }) => void
  ): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    this.backgroundStreamListeners.push(callback)
    return () => {
      const idx = this.backgroundStreamListeners.indexOf(callback)
      if (idx !== -1) {
        this.backgroundStreamListeners.splice(idx, 1)
      }
    }
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(
    callback: (payload: { id: string; code: number; incarnationId?: PtyIncarnationId }) => void
  ): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    this.writeUnavailableListeners.push(callback)
    return () => {
      const idx = this.writeUnavailableListeners.indexOf(callback)
      if (idx !== -1) {
        this.writeUnavailableListeners.splice(idx, 1)
      }
    }
  }

  protected emitWriteUnavailable(id: string): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const listener of [...this.writeUnavailableListeners]) {
      listener({ id })
    }
  }

  dispose(): void {
    this.respawnAdoptionClosed = true
    this.sessionsAwaitingDaemonRecovery.clear()
    this.writeRecoveryAttempted = false
    this.releasePendingRespawnAdoptionLease()
    this.stopCheckpointTimer()
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.sessionsNeedingLiveCheckpoint.clear()
    this.sessionsNeedingContinuityCheckpoint.clear()
    this.overlayDeadlineWarnedSessionIds.clear()
    this.periodicDeadlineWarnedSessionIds.clear()
    this.nonFinalAdmissionDeniedSessionIds.clear()
    this.coldRestoreCache.clear()
    this.wslDistrosBySessionId.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.auditObservationListeners.length = 0
    this.identityChangeListeners.length = 0
    this.removeEventListener?.()
    this.removeEventListener = null
    // Why: final checkpoints are written daemon-side (TerminalHost.dispose); here the adapter only marks sessions
    // cleanly ended so they don't trigger false cold restores.
    if (this.historyManager) {
      void this.historyManager
        .dispose()
        .catch((err) => console.warn('[history] dispose failed:', err))
    }
    this.client.disconnect()
  }

  async establishLifecycleLease(): Promise<void> {
    if (this.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      return
    }
    // Why: an authenticated pair cancels the adoption watchdog and lets a never-used adapter retire its empty daemon on quit.
    await this.client.ensureConnected()
    this.recordAuthenticatedIdentity()
  }

  // Why: unlike dispose(), leave history files unclean (no endedAt) so the next launch treats them as crash-recoverable,
  // but still write a final checkpoint so a daemon crash while Orca is closed has recovery data.
  async disconnectOnly(): Promise<void> {
    if (!this.disconnectOnlyPromise) {
      this.respawnAdoptionClosed = true
      this.sessionsAwaitingDaemonRecovery.clear()
      this.writeRecoveryAttempted = false
      this.releasePendingRespawnAdoptionLease()
      this.disconnectOnlyPromise = this.finishDisconnectOnly([...this.keepHistoryShutdowns])
    }
    await this.disconnectOnlyPromise
  }

  protected async finishDisconnectOnly(keepHistoryShutdowns: Promise<void>[]): Promise<void> {
    // Why: sleep shutdowns still detect recovery and kill after checkpointing; disconnecting first rejects those admitted operations.
    await Promise.allSettled(keepHistoryShutdowns)
    this.respawnAdoptionClosed = true
    // Why: a final checkpoint covers sessions opened since the last tick (else cold restore finds nothing if the daemon
    // later dies). Await it — fire-and-forget would race client.disconnect() and reject the pending getSnapshot RPCs.
    await this.runExclusiveCheckpoint(() => this.checkpointAllSessions(), {
      rescheduleDirty: false
    })
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.coldRestoreCache.clear()
    this.wslDistrosBySessionId.clear()
    // Why: the detached daemon keeps these PTYs alive for warm reattach; a leftover pause would stall shells for a failsafe window.
    for (const id of this.pausedProducerSessionIds) {
      this.client.notify('resumePty', { sessionId: id })
    }
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.removeEventListener?.()
    this.removeEventListener = null
    if (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      try {
        // Why: only the authenticated daemon can atomically prove it's empty; a shared budget keeps this off quit's critical path.
        const deadlineMs = Date.now() + 250
        if (!this.client.isConnected()) {
          await this.client.ensureConnectedWithin(Math.max(1, deadlineMs - Date.now()))
        }
        await this.client.request('shutdownIfIdle', undefined, Math.max(1, deadlineMs - Date.now()))
      } catch {
        // An unreachable daemon falls back to event-driven retirement once its auth sockets close and it proves itself empty.
      }
    }
    this.client.disconnect()
  }
}
