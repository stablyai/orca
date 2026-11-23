import {
  STATUS_FLUSH_BUSY_TIMEOUT_MS,
  STATUS_PERSIST_MIN_INTERVAL_MS,
  STATUS_TURN_EDGE_PERSIST_INTERVAL_MS,
  STATUS_PERSIST_RETRY_MAX_MS,
  STATUS_PERSIST_RETRY_MIN_MS
} from './server-constants'
import { AgentHookServerStatusFile } from './server-status-file'
import { LastStatusStore } from './last-status-store'
import { rowsOf } from './last-status-saved-rows'
import { nextRetryDelayMs } from '../../sqlite/row-cache/row-cache-failure'

export abstract class AgentHookServerPersistence extends AgentHookServerStatusFile {
  private statusStore: LastStatusStore | null = null
  private statusStorePath: string | null = null
  private statusPersistFailing = false
  private statusPersistRetryDelayMs = 0
  private statusPersistRetryAt = 0

  private persistedExitRevision = -1
  // The 3-minute batch runs off its own clock, so frequent turn-edge saves never postpone it.
  private lastFullStatusPersistStartedAt = Number.NEGATIVE_INFINITY

  // Leading-edge throttling prevents event streams from postponing writes indefinitely (#26720).
  protected scheduleStatusPersist(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    const now = Date.now()
    // Persist authority changes immediately to preserve spool replay filtering after a crash.
    const urgent = this.currentAuthorityFingerprint() !== this.lastPersistedAuthorityFingerprint
    // A restart that skips quit restores a reattached agent's turn from disk, so a turn edge
    // saves within a second; coalescing keeps many agents' edges to one write.
    // A wall-clock rollback must not defer persistence indefinitely.
    const throttledAt = urgent
      ? now
      : this.restoredStateEdges.turnKeys.size > 0
        ? Math.min(
            this.lastStatusPersistStartedAt + STATUS_TURN_EDGE_PERSIST_INTERVAL_MS,
            now + STATUS_TURN_EDGE_PERSIST_INTERVAL_MS
          )
        : Math.min(
            this.lastFullStatusPersistStartedAt + STATUS_PERSIST_MIN_INTERVAL_MS,
            now + STATUS_PERSIST_MIN_INTERVAL_MS
          )
    // After a failed save every attempt, urgent or not, waits for the short retry backoff.
    const dueAt = this.statusPersistRetryAt > now ? this.statusPersistRetryAt : throttledAt
    if (this.statusPersistTimer) {
      if (dueAt >= this.statusPersistDueAt) {
        return
      }
      clearTimeout(this.statusPersistTimer)
    }
    this.statusPersistDueAt = Math.max(dueAt, now)
    this.statusPersistTimer = setTimeout(() => {
      this.statusPersistTimer = null
      this.runStatusPersist()
    }, this.statusPersistDueAt - now)
    // Quit flushes synchronously; this timer must not keep the runtime alive.
    if (typeof this.statusPersistTimer.unref === 'function') {
      this.statusPersistTimer.unref()
    }
  }

  /** Quit, stop and hook-disable: one bounded lock wait, then the failure is reported. */
  flushStatusPersistSync(): boolean {
    this.cancelStatusPersistTimer()
    if (!this.lastStatusFilePath) {
      return true
    }
    return this.runStatusPersist(STATUS_FLUSH_BUSY_TIMEOUT_MS, true)
  }

  /** Writes only changed rows; a failure (including a held lock) retries with backoff. Between
   *  batches, a save for turn edges alone writes only the edged panes' rows. */
  protected runStatusPersist(busyTimeoutMs = 0, flush = false): boolean {
    const store = this.getStatusStore()
    if (!store) {
      return true
    }
    if (store.isDisabled) {
      this.clearStatusPersistDebt()
      // Nothing reaches disk this session; flush callers must not read that as saved.
      return false
    }
    const now = Date.now()
    const fingerprint = this.currentAuthorityFingerprint()
    const turnOnly =
      !flush &&
      this.restoredStateEdges.turnKeys.size > 0 &&
      fingerprint === this.lastPersistedAuthorityFingerprint &&
      now < this.lastFullStatusPersistStartedAt + STATUS_PERSIST_MIN_INTERVAL_MS &&
      now >= this.lastFullStatusPersistStartedAt
    this.lastStatusPersistStartedAt = now
    if (turnOnly) {
      return this.runTurnEdgePersist(store, busyTimeoutMs)
    }
    const previousFullAt = this.lastFullStatusPersistStartedAt
    this.lastFullStatusPersistStartedAt = now
    try {
      const keys = new Set([
        ...this.statusPersistDirtyKeys,
        ...this.hydratedLaunchTokenHashByPaneKey.dirtyKeys,
        ...this.persistedAuthorityCommitmentsByPaneKey.dirtyKeys
      ])
      let exitsDirty = this.persistedExitRevision !== this.agentExitedAtByPaneKey.revision
      for (const expired of this.statusCacheExpiry.takeDue(Date.now())) {
        const separator = expired.indexOf('\0')
        if (expired.startsWith('exit\0')) {
          exitsDirty = true
          this.persistedExitRevision = -1
        } else {
          keys.add(expired.slice(separator + 1))
        }
      }
      for (const key of keys) {
        this.statusPersistDirtyKeys.add(key)
      }
      const file = this.buildStatusFile([...keys], exitsDirty)
      const changes = new Map<string, string | null>()
      for (const key of keys) {
        changes.set(`entry\0${key}`, null)
        changes.set(`commitment\0${key}`, null)
      }
      if (exitsDirty) {
        changes.set('exits\0', null)
      }
      for (const row of rowsOf(file)) {
        changes.set(row.key, row.json)
      }
      const reinsertKeys = new Set([...this.statusPersistRemovedKeys].map((key) => `entry\0${key}`))
      store.patch(changes, () => this.buildStatusFile(), busyTimeoutMs, reinsertKeys)
      this.statusPersistDirtyKeys.clear()
      this.statusPersistRemovedKeys.clear()
      this.hydratedLaunchTokenHashByPaneKey.dirtyKeys.clear()
      this.persistedAuthorityCommitmentsByPaneKey.dirtyKeys.clear()
      this.agentExitedAtByPaneKey.dirtyKeys.clear()
      this.persistedExitRevision = this.agentExitedAtByPaneKey.revision
      this.restoredStateEdges.turnKeys.clear()
    } catch (err) {
      // The retry is still the batch, not a turn-edge save.
      this.lastFullStatusPersistStartedAt = previousFullAt
      return this.retryStatusPersist(err)
    }
    // Only a committed save can stand in for the authority it carries.
    this.lastPersistedAuthorityFingerprint = fingerprint
    return this.settleStatusPersist()
  }

  /** The edged panes' rows only; every other dirty row stays pending for the batch. */
  private runTurnEdgePersist(store: LastStatusStore, busyTimeoutMs: number): boolean {
    const keys = [...this.restoredStateEdges.turnKeys]
    try {
      const changes = new Map<string, string | null>()
      for (const key of keys) {
        changes.set(`entry\0${key}`, null)
        changes.set(`commitment\0${key}`, null)
      }
      for (const row of rowsOf(this.buildStatusFile(keys, false))) {
        changes.set(row.key, row.json)
      }
      const reinsertKeys = new Set(
        keys.filter((key) => this.statusPersistRemovedKeys.has(key)).map((key) => `entry\0${key}`)
      )
      store.patch(changes, () => this.buildStatusFile(), busyTimeoutMs, reinsertKeys)
      for (const key of keys) {
        this.restoredStateEdges.turnKeys.delete(key)
        this.statusPersistDirtyKeys.delete(key)
        this.statusPersistRemovedKeys.delete(key)
      }
    } catch (err) {
      return this.retryStatusPersist(err)
    }
    const settled = this.settleStatusPersist()
    // The batch still owes the rows this save skipped.
    this.scheduleStatusPersist()
    return settled
  }

  private retryStatusPersist(err: unknown): false {
    this.reportStatusPersistFailure(err)
    this.statusPersistRetryDelayMs = nextRetryDelayMs(this.statusPersistRetryDelayMs, {
      minMs: STATUS_PERSIST_RETRY_MIN_MS,
      maxMs: STATUS_PERSIST_RETRY_MAX_MS
    })
    this.statusPersistRetryAt = Date.now() + this.statusPersistRetryDelayMs
    // Retry even if no later mutation arrives.
    this.scheduleStatusPersist()
    return false
  }

  private settleStatusPersist(): true {
    this.statusPersistFailing = false
    this.statusPersistRetryDelayMs = 0
    this.statusPersistRetryAt = 0
    return true
  }

  private clearStatusPersistDebt(): void {
    this.restoredStateEdges.turnKeys.clear()
    this.statusPersistDirtyKeys.clear()
    this.statusPersistRemovedKeys.clear()
    this.hydratedLaunchTokenHashByPaneKey.dirtyKeys.clear()
    this.persistedAuthorityCommitmentsByPaneKey.dirtyKeys.clear()
    this.agentExitedAtByPaneKey.dirtyKeys.clear()
  }

  protected closeStatusSnapshotWriter(): void {
    this.tracksStatusPersistence = () => false
    this.clearStatusPersistDebt()
    this.cancelStatusPersistTimer()
    this.statusStore?.close()
    this.statusStore = null
    this.statusStorePath = null
    this.statusCacheExpiry.clear()
    this.persistedExitRevision = -1
    this.lastStatusPersistStartedAt = Number.NEGATIVE_INFINITY
    this.lastPersistedAuthorityFingerprint = null
    this.lastFullStatusPersistStartedAt = Number.NEGATIVE_INFINITY
    this.statusPersistFailing = false
    this.statusPersistRetryDelayMs = 0
    this.statusPersistRetryAt = 0
  }

  protected getStatusStore(): LastStatusStore | null {
    const filePath = this.lastStatusFilePath
    if (!filePath) {
      return null
    }
    if (!this.statusStore || this.statusStorePath !== filePath) {
      this.statusStore?.close()
      this.statusStore = new LastStatusStore(filePath)
      this.statusStorePath = filePath
      const store = this.statusStore
      this.tracksStatusPersistence = () => !store.isDisabled
    }
    return this.statusStore
  }

  /** Revision counters and live tokens avoid per-event hashing or serialization. */
  protected currentAuthorityFingerprint(): string {
    return `${this.hydratedLaunchTokenHashByPaneKey.revision}:${this.persistedAuthorityCommitmentsByPaneKey.revision}:${this.restoredStateEdges.authority}`
  }

  private cancelStatusPersistTimer(): void {
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
      this.statusPersistTimer = null
    }
  }

  private reportStatusPersistFailure(err: unknown): void {
    if (!this.statusPersistFailing) {
      console.warn('[agent-hooks] failed to save agent status:', err)
    }
    this.statusPersistFailing = true
  }

  _resetPromptSentDedupeForTests(): void {
    this.promptSentDedupeByPaneKey.clear()
  }

  _resetConnectionTimestampWatermarksForTests(): void {
    this.connectionTimestampWatermarkById.clear()
  }
}
