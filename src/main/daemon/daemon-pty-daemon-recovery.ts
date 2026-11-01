import { emitPtyListeners } from './daemon-pty-listener-emission'
import { existsSync } from 'node:fs'
import { getMacDaemonSystemResolverHealth } from './daemon-health'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { isDaemonStaleForCurrentBundle } from './daemon-bundle-staleness'
import { isDaemonGoneError, isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { DaemonPtyCheckpointPersistence } from './daemon-pty-checkpoint-persistence'
import type { DaemonRespawnReason } from './daemon-pty-runtime-state'
import type { ListSessionsResult } from './types'
import type { PtyBackgroundStreamEvent } from '../providers/pty-provider-contract'
import type { TerminalLimitStatus, TerminalLimitUpdate } from '../../shared/terminal-limit-policy'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

export abstract class DaemonPtyDaemonRecovery extends DaemonPtyCheckpointPersistence {
  abstract getDaemonIdentity(): DaemonEndpointIdentity | null

  async terminalLimit(update?: TerminalLimitUpdate): Promise<TerminalLimitStatus | null> {
    await this.ensureConnected()
    const identity = this.getDaemonIdentity()
    if (update && identity?.launchNonce !== update.daemonNonce) {
      throw new Error('Terminal host changed. Refresh the setting and try again.')
    }
    try {
      const type = update ? 'setTerminalLimit' : 'terminalLimitStatus'
      const status = await this.client.request<TerminalLimitStatus>(type, update)
      if (
        !identity ||
        this.getDaemonIdentity()?.launchNonce !== identity.launchNonce ||
        status.daemonNonce !== identity.launchNonce
      ) {
        throw new Error('Terminal host changed. Refresh the setting and try again.')
      }
      return status
    } catch (error) {
      if (isUnknownRequestTypeError(error)) {
        return null
      }
      throw error
    }
  }

  // Token reads no longer throw; check absence explicitly after an authenticated disconnect.
  protected isRetiredEndpointTokenMissing(): boolean {
    return this.client.hasObservedAuthenticatedDisconnect() && !existsSync(this.tokenPath)
  }

  protected async withDaemonRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      const missingRetiredEndpointToken = this.isRetiredEndpointTokenMissing()
      if (missingRetiredEndpointToken) {
        this.observeAuditFailure(
          'token_missing_after_authenticated_disconnect',
          this.exactDaemonIncarnation,
          ['token_file']
        )
      }
      if (this.respawnAdoptionClosed || !this.respawnFn || !isDaemonGoneError(err)) {
        throw err
      }
      if (!this.respawnPromise) {
        this.respawnPromise = this.doRespawn().finally(() => {
          this.respawnPromise = null
        })
      }
      await this.respawnPromise
      try {
        return await fn()
      } finally {
        // A tombstone can reject retry before connect; release its temporary adoption lease anyway.
        this.releasePendingRespawnAdoptionLease()
      }
    }
  }

  protected reconnectAfterWriteFailure(): void {
    if (
      this.writeRecoveryPromise ||
      this.writeRecoveryAttempted ||
      this.respawnAdoptionClosed ||
      !this.respawnFn
    ) {
      return
    }
    this.writeRecoveryAttempted = true
    // Notify every pane before clearing active IDs so sibling recovery passes the renderer's liveness gate.
    this.notifyActiveSessionsWriteUnavailable()
    const recovery = this.withDaemonRetry(() => this.ensureConnected())
      .catch((error) => console.warn('[daemon] Failed to recover after rejected PTY input:', error))
      .finally(() => {
        this.releasePendingRespawnAdoptionLease()
        if (this.writeRecoveryPromise === recovery) {
          this.writeRecoveryPromise = null
        }
      })
    this.writeRecoveryPromise = recovery
  }

  // Reconnect on endpoint loss without waiting for input; only daemon-gone errors permit respawn.
  protected recoverAfterEndpointLoss(): void {
    if (this.activeSessionIds.size > 0) {
      this.reconnectAfterWriteFailure()
    }
  }

  protected notifyActiveSessionsWriteUnavailable(): void {
    // Snapshot IDs before callbacks mutate the set so no sibling misses recovery.
    const ids = [...this.activeSessionIds]
    for (const id of ids) {
      this.sessionsAwaitingDaemonRecovery.add(id)
      this.emitWriteUnavailable(id)
    }
  }

  protected clearSessionAwaitingDaemonRecovery(sessionId: string): void {
    this.sessionsAwaitingDaemonRecovery.delete(sessionId)
    if (this.sessionsAwaitingDaemonRecovery.size === 0) {
      this.writeRecoveryAttempted = false
    }
  }

  protected async withHistorySpawnLock<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!this.historyManager) {
      return await operation()
    }
    const previous = this.historySpawnLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.historySpawnLocks.set(sessionId, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.historySpawnLocks.get(sessionId) === tail) {
        this.historySpawnLocks.delete(sessionId)
      }
    }
  }

  protected async replaceUnhealthyMacResolverDaemonBeforeNewPty(): Promise<void> {
    if (!this.respawnFn) {
      return
    }

    const health = await getMacDaemonSystemResolverHealth(
      this.socketPath,
      this.tokenPath,
      this.protocolVersion
    )
    if (health !== 'unhealthy') {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] macOS system resolver unavailable - preserving daemon because live session state could not be verified'
          : `[daemon] macOS system resolver unavailable - preserving daemon because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return
    }

    // Replacement has no exit fanout; notify panes before their PTYs disappear.
    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] macOS system resolver unavailable - respawning daemon',
        'unhealthy_resolver'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  /** Replace a stale packaged daemon only after its live sessions drain. */
  protected async replaceStaleBundleDaemonBeforeNewPty(): Promise<void> {
    if (!this.respawnFn || !this.runtimeDir || !this.packagedAppVersion) {
      return
    }
    if (!this.staleBundleReplacementPromise) {
      this.staleBundleReplacementPromise = this.replaceStaleBundleDaemonOnce(
        this.runtimeDir,
        this.packagedAppVersion
      ).finally(() => {
        this.staleBundleReplacementPromise = null
      })
    }
    await this.staleBundleReplacementPromise
  }

  protected async replaceStaleBundleDaemonOnce(
    runtimeDir: string,
    packagedAppVersion: string
  ): Promise<void> {
    const stale = await isDaemonStaleForCurrentBundle(
      runtimeDir,
      this.socketPath,
      this.tokenPath,
      packagedAppVersion,
      this.protocolVersion
    )
    if (!stale) {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] Packaged daemon is stale - preserving it because live session state could not be verified'
          : `[daemon] Packaged daemon is stale - preserving it because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
      )
      return
    }

    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] Packaged daemon is stale - respawning from the current app bundle',
        'stale_bundle'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  /** Replace a TCC-severed daemon only after its live sessions drain. */
  protected async replaceSeveredMacTccDaemonBeforeNewPty(): Promise<void> {
    // Attribution health returns unknown off macOS.
    if (!this.respawnFn || !this.runtimeDir) {
      return
    }

    const health = await getMacDaemonTccAttributionHealth(
      this.runtimeDir,
      this.socketPath,
      this.tokenPath,
      this.protocolVersion
    )
    if (health !== 'severed') {
      return
    }

    const daemonLiveSessionCount = await this.getDaemonLiveSessionCount()
    const liveSessionCount = Math.max(this.activeSessionIds.size, daemonLiveSessionCount ?? 0)
    if (daemonLiveSessionCount === null || liveSessionCount > 0) {
      console.warn(
        daemonLiveSessionCount === null
          ? '[daemon] macOS TCC attribution severed - preserving daemon because live session state could not be verified'
          : `[daemon] macOS TCC attribution severed - preserving daemon because it owns ${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}; restart from Manage Sessions when ready`
      )
      return
    }

    this.fanoutSyntheticExits(-1)
    if (!this.respawnPromise) {
      this.respawnPromise = this.doRespawn(
        '[daemon] macOS TCC attribution severed - respawning daemon under the current app binary',
        'severed_tcc_attribution'
      ).finally(() => {
        this.respawnPromise = null
      })
    }
    await this.respawnPromise
  }

  protected async getDaemonLiveSessionCount(): Promise<number | null> {
    try {
      await this.client.ensureConnected()
      const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
      return result.sessions.filter((session) => session.isAlive).length
    } catch {
      return null
    }
  }

  protected emitBackgroundStreamEvent(payload: PtyBackgroundStreamEvent): void {
    emitPtyListeners(this.backgroundStreamListeners, (listener) => listener(payload))
  }

  protected async doRespawn(
    message = '[daemon] Daemon died — respawning',
    reason: DaemonRespawnReason = 'daemon_died'
  ): Promise<void> {
    console.warn(message)
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
    const releaseAdoptionLease = await this.respawnFn!(reason)
    if (this.respawnAdoptionClosed) {
      // Teardown can win during respawn; release a late lease instead of leaving it unowned.
      releaseAdoptionLease?.()
      throw new Error('Daemon adapter closed during respawn')
    }
    this.pendingRespawnAdoptionRelease = releaseAdoptionLease ?? null
  }

  protected releasePendingRespawnAdoptionLease(): void {
    const release = this.pendingRespawnAdoptionRelease
    this.pendingRespawnAdoptionRelease = null
    release?.()
  }
}
