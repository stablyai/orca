import { existsSync } from 'node:fs'
import { getMacDaemonSystemResolverHealth } from './daemon-health'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { isDaemonStaleForCurrentBundle } from './daemon-bundle-staleness'
import { isDaemonGoneError } from './daemon-endpoint-errors'
import { DaemonPtyCheckpointPersistence } from './daemon-pty-checkpoint-persistence'
import type { DaemonRespawnReason } from './daemon-pty-runtime-state'
import type { ListSessionsResult } from './types'
import type { PtyBackgroundStreamEvent } from '../providers/types'

export abstract class DaemonPtyDaemonRecovery extends DaemonPtyCheckpointPersistence {
  // Why: the token read no longer throws, so audit its absence directly after an authenticated drop.
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
        // Why: the retried op may reject before any connection attempt (e.g. a tombstone racing respawn).
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
    // Why: the dead endpoint took down every session on this daemon. Signal all
    // active panes now — while they are still in activeSessionIds, so the
    // renderer's liveness gate still reads them live — so background panes
    // remount + re-attach alongside the one that was written, instead of being
    // left frozen with silently dropped input until each is typed into.
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

  protected notifyActiveSessionsWriteUnavailable(): void {
    // Snapshot first: a listener that kills a pane would mutate activeSessionIds
    // mid-iteration and silently skip the sibling this fan-out exists to reach.
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

    // Why: replacing the daemon kills its sessions without exit fanout; emit exits first so panes don't write to dead PTYs.
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
    // Why no platform gate: getMacDaemonTccAttributionHealth returns 'unknown' off macOS.
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
    // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: listeners may unsubscribe during iteration
    for (const listener of [...this.backgroundStreamListeners]) {
      listener(payload)
    }
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
      // Why: app teardown may win mid-respawn; a late result must not reinstall a lease nobody owns.
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
