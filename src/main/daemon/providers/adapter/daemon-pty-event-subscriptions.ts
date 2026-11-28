import type { DaemonPtyRouterDataEvent } from '../../protocol/daemon-pty-router-events'
import { removeDaemonListener } from '../../observability/daemon-listener-registry'
import { emitPtyListeners } from './daemon-pty-listener-emission'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import { DaemonPtySessionInventory } from './daemon-pty-session-inventory'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import {
  countLiveDaemonSessions,
  type ListSessionsResult,
  type ShutdownIfIdleResult
} from '../../protocol/daemon-rpc-contract'
import type { DaemonIdleRetirementResult } from './daemon-pty-runtime-state'
import type { PtyBackgroundStreamEvent } from '../../../providers/pty/events'
import { readDaemonWslQuitCwds } from '../wsl/daemon-wsl-sleep-cwd'
import { RETIRE_WHEN_IDLE_REQUEST } from '../../server/daemon-superseded-clients'
import { isUnknownRequestTypeError } from '../../endpoint/identity/daemon-endpoint-errors'
import { isDaemonEndpointGoneError } from '../../protocol/daemon-errors'

export abstract class DaemonPtyEventSubscriptions extends DaemonPtySessionInventory {
  /** The live connection asked the daemon to retire when idle. */
  private heldForRetirement = false
  /** A held connection dropped and nothing has reconnected since: the daemon may have retired. */
  private heldConnectionDropped = false
  private stopHeldDropWatch: (() => void) | null = null

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
    this.wslPaneKeysBySessionId.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.auditObservationListeners.length = 0
    this.identityChangeListeners.length = 0
    this.removeEventListener?.()
    this.removeEventListener = null
    this.stopHeldDropWatch?.()
    this.stopHeldDropWatch = null
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
        liveSessions = countLiveDaemonSessions(inventory)
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

  /** Asks an older generation to retire by itself once it owns nothing; 'unsupported' predates the request. */
  async askRetireWhenIdle(
    currentProtocolVersion: number
  ): Promise<'held' | 'unsupported' | 'unanswered'> {
    try {
      await this.ensureConnected()
      await this.client.request(RETIRE_WHEN_IDLE_REQUEST, { currentProtocolVersion })
      this.heldForRetirement = true
      this.heldConnectionDropped = false
      this.stopHeldDropWatch ??= this.client.onDisconnected(() => {
        this.heldConnectionDropped ||= this.heldForRetirement
        this.heldForRetirement = false
      })
      return 'held'
    } catch (error) {
      return isUnknownRequestTypeError(error) ? 'unsupported' : 'unanswered'
    }
  }

  /** After a held connection drops: retired only once the endpoint is proven gone with no tracked session. */
  async confirmRetiredWhenIdle(): Promise<'retired' | 'connected' | 'reconnected' | 'unknown'> {
    if (this.idleRetirementState === 'retiring') {
      return 'retired'
    }
    if (this.client.isConnected()) {
      return 'connected'
    }
    if (!this.heldConnectionDropped || this.activeSessionIds.size > 0) {
      return 'unknown'
    }
    try {
      await this.ensureConnected()
      // The new connection keeps the daemon alive until it is asked again.
      this.heldConnectionDropped = false
      return 'reconnected'
    } catch (error) {
      if (!isDaemonEndpointGoneError(error) || this.activeSessionIds.size > 0) {
        return 'unknown'
      }
      this.idleRetirementState = 'retiring'
      this.idleRetirementAdmissionClosed = true
      this.respawnAdoptionClosed = true
      return 'retired'
    }
  }

  /** Asked to retire on the live connection; the daemon may decide at any moment. */
  isHeldForRetirement(): boolean {
    return this.heldForRetirement
  }

  /** Asked to retire, on the live connection or on one that dropped since. */
  wasAskedToRetireWhenIdle(): boolean {
    return this.heldForRetirement || this.heldConnectionDropped
  }

  onConnectionLost(listener: () => void): () => void {
    return this.client.onDisconnected(listener)
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

  private wslBridgePanesForQuit(): { sessionId: string; paneKey: string; wslDistro: string }[] {
    return [...this.activeSessionIds].flatMap((sessionId) => {
      const wslDistro = this.wslDistrosBySessionId.get(sessionId)
      const paneKey = this.wslPaneKeysBySessionId.get(sessionId)
      return wslDistro && paneKey ? [{ sessionId, paneKey, wslDistro }] : []
    })
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
    // Bridge bash reports no folder and the daemon outlives quit; a distro stopped before relaunch leaves only this read.
    const shellCwds = await readDaemonWslQuitCwds(
      this.wslBridgePanesForQuit(),
      this.quitWslCwdBudgetMs
    )
    // Await final checkpoints, including new sessions, before disconnect can reject their snapshot RPCs.
    await this.runExclusiveCheckpoint(
      async () => {
        for (const [id, cwd] of shellCwds) {
          this.probedShellCwds.set(id, cwd)
        }
        try {
          await this.checkpointAllSessions()
        } finally {
          for (const id of shellCwds.keys()) {
            this.probedShellCwds.delete(id)
          }
        }
      },
      { rescheduleDirty: false }
    )
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.coldRestoreCache.clear()
    this.wslDistrosBySessionId.clear()
    this.wslPaneKeysBySessionId.clear()
    // Daemon PTYs survive disconnect; resume producers so warm reattach does not wait for a pause failsafe.
    for (const id of this.pausedProducerSessionIds) {
      this.client.notify('resumePty', { sessionId: id })
    }
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.removeEventListener?.()
    this.removeEventListener = null
    // A daemon that already accepted idle retirement is leaving; asking again would only reconnect.
    if (
      this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION &&
      this.idleRetirementState !== 'retiring'
    ) {
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
