import type { DaemonPtyRouterDataEvent } from './daemon-pty-router-events'
import { removeDaemonListener } from './daemon-listener-registry'
import { emitPtyListeners } from './daemon-pty-listener-emission'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import { DaemonPtySessionInventory } from './daemon-pty-session-inventory'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  type ListSessionsResult,
  type ShutdownIfIdleResult
} from './types'
import type { DaemonIdleRetirementResult } from './daemon-pty-runtime-state'
import type { PtyBackgroundStreamEvent } from '../providers/pty-provider-contract'

export abstract class DaemonPtyEventSubscriptions extends DaemonPtySessionInventory {
  onData(callback: (payload: DaemonPtyRouterDataEvent) => void): () => void {
    this.dataListeners.push(callback)
    return () => removeDaemonListener(this.dataListeners, callback)
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    this.backgroundStreamListeners.push(callback)
    return () => removeDaemonListener(this.backgroundStreamListeners, callback)
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(
    callback: (payload: { id: string; code: number; incarnationId?: PtyIncarnationId }) => void
  ): () => void {
    this.exitListeners.push(callback)
    return () => removeDaemonListener(this.exitListeners, callback)
  }

  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    this.writeUnavailableListeners.push(callback)
    return () => removeDaemonListener(this.writeUnavailableListeners, callback)
  }

  protected emitWriteUnavailable(id: string): void {
    emitPtyListeners(this.writeUnavailableListeners, (listener) => {
      try {
        listener({ id })
      } catch (error) {
        // Renderer notification failure must not cancel recovery or erase write evidence.
        console.warn('[daemon] Write unavailable listener failed:', error)
      }
    })
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
    // Daemon-side teardown writes final checkpoints; adapter disposal marks history ended to prevent false restores.
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
    // An authenticated pair cancels adoption timeout and lets even an unused adapter retire its empty daemon.
    await this.client.ensureConnected()
    this.recordAuthenticatedIdentity()
  }

  async requestIdleRetirement(): Promise<DaemonIdleRetirementResult> {
    if (this.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      return { state: 'unsupported' }
    }
    if (this.idleRetirementState === 'retiring') {
      return { state: 'retiring' }
    }
    if (this.idleRetirementPromise) {
      return this.idleRetirementPromise
    }
    if (
      this.disconnectOnlyPromise ||
      (this.respawnAdoptionClosed && this.idleRetirementState === 'open')
    ) {
      return { state: 'unverifiable' }
    }
    this.idleRetirementAdmissionClosed = true
    this.respawnAdoptionClosed = true
    this.idleRetirementState = 'checking'
    const request = this.finishIdleRetirementRequest().finally(() => {
      if (this.idleRetirementPromise === request) {
        this.idleRetirementPromise = null
      }
    })
    this.idleRetirementPromise = request
    return request
  }

  private async finishIdleRetirementRequest(): Promise<DaemonIdleRetirementResult> {
    try {
      await this.client.ensureConnected()
    } catch {
      // No retirement RPC was sent; reopen this adapter's admission.
      this.reopenAfterRefusedIdleRetirement()
      return { state: 'unverifiable' }
    }
    try {
      const result = await this.client.request<ShutdownIfIdleResult>('shutdownIfIdle', undefined)
      if (result.retiring) {
        this.idleRetirementState = 'retiring'
        return { state: 'retiring' }
      }
      let liveSessions: number | null = null
      try {
        const inventory = await this.client.request<ListSessionsResult>('listSessions', undefined)
        liveSessions = inventory.sessions.filter((session) => session.isAlive).length
      } catch {
        liveSessions = null
      }
      this.reopenAfterRefusedIdleRetirement()
      return {
        state: 'busy',
        liveSessions,
        admissionReopened: true
      }
    } catch {
      // The daemon may have accepted before contact was lost; keep admission and respawn fenced.
      this.idleRetirementState = 'unverifiable'
      return { state: 'unverifiable' }
    }
  }

  /** True once this daemon accepted idle retirement: it is leaving and never serves again. */
  hasRetiredForIdle(): boolean {
    return this.idleRetirementState === 'retiring'
  }

  /** Whether an idle-retirement attempt still refuses new terminals here. */
  isIdleRetirementAdmissionClosed(): boolean {
    return this.idleRetirementAdmissionClosed
  }

  /** Reopens admission an idle-retirement attempt fenced without retiring the daemon. */
  releaseIdleRetirementFence(): void {
    // An unverifiable attempt may have been accepted, so it stays fenced like a retiring one.
    if (
      this.idleRetirementState !== 'retiring' &&
      this.idleRetirementState !== 'unverifiable' &&
      !this.idleRetirementPromise
    ) {
      this.reopenAfterRefusedIdleRetirement()
    }
  }

  private reopenAfterRefusedIdleRetirement(): void {
    this.idleRetirementState = 'open'
    this.idleRetirementAdmissionClosed = false
    this.respawnAdoptionClosed = false
  }

  // Checkpoint without marking history ended so a daemon crash after app quit remains recoverable.
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
    // Let admitted sleep shutdowns finish recovery and kill RPCs before disconnecting their client.
    await Promise.allSettled(keepHistoryShutdowns)
    this.respawnAdoptionClosed = true
    // Await final checkpoints, including new sessions, before disconnect can reject their snapshot RPCs.
    await this.runExclusiveCheckpoint(() => this.checkpointAllSessions(), {
      rescheduleDirty: false
    })
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.coldRestoreCache.clear()
    this.wslDistrosBySessionId.clear()
    // Daemon PTYs survive disconnect; resume producers so warm reattach does not wait for a pause failsafe.
    for (const id of this.pausedProducerSessionIds) {
      this.client.notify('resumePty', { sessionId: id })
    }
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.removeEventListener?.()
    this.removeEventListener = null
    if (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      try {
        // Only the authenticated daemon can prove emptiness atomically; share a short quit-time budget.
        const deadlineMs = Date.now() + 250
        if (!this.client.isConnected()) {
          await this.client.ensureConnectedWithin(Math.max(1, deadlineMs - Date.now()))
        }
        await this.client.request('shutdownIfIdle', undefined, Math.max(1, deadlineMs - Date.now()))
      } catch {
        // Closing auth sockets still permits the daemon to retire itself once empty.
      }
    }
    this.client.disconnect()
  }
}
