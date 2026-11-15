import { isValidPaneKey } from './server-status-identity'
import { AGENT_STATUS_HYDRATE_MAX_AGE_MS as HYDRATE_MAX_AGE_MS } from '../../../shared/agent-status/contracts/agent-status-freshness'
import {
  LAST_STATUS_FILE_VERSION,
  STATUS_FLUSH_BUSY_TIMEOUT_MS,
  STATUS_PERSIST_MIN_INTERVAL_MS,
  STATUS_PERSIST_RETRY_MAX_MS,
  STATUS_PERSIST_RETRY_MIN_MS
} from './server-constants'
import type {
  EnrichedAgentHookEventPayload,
  LastStatusFile,
  PersistedAgentHookAuthorityCommitment,
  PersistedAgentHookEventPayload
} from './server-types'
import { authorityCommitmentsMatch } from './server-persistence-validation'
import { AgentHookServerHydration } from './server-hydration'
import { pruneAgentExits, serializeAgentExits } from './agent-exit-evidence'
import { LastStatusStore } from './last-status-store'
import { StatusCacheExpiry } from './status-cache-expiry'
import { rowsOf, selectedStatusEntries } from './last-status-saved-rows'
import { nextRetryDelayMs } from '../../sqlite/row-cache/row-cache-failure'

export abstract class AgentHookServerPersistence extends AgentHookServerHydration {
  private statusStore: LastStatusStore | null = null
  private statusStorePath: string | null = null
  private statusPersistFailing = false
  private statusPersistRetryDelayMs = 0
  private statusPersistRetryAt = 0

  private readonly statusCacheExpiry = new StatusCacheExpiry()
  private persistedExitRevision = -1

  protected buildStatusFile(keys?: readonly string[], includeExits = true): LastStatusFile {
    if (!keys) {
      this.statusCacheExpiry.clear()
    }
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    // Restart drops anything older than the TTL, so saving it would only carry dead rows forward.
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, commitment] of selectedStatusEntries(
      this.persistedAuthorityCommitmentsByPaneKey,
      keys
    )) {
      this.statusCacheExpiry.set(
        `commitment\0${paneKey}`,
        commitment.observedAt >= ttlCutoff ? commitment.observedAt + HYDRATE_MAX_AGE_MS : undefined
      )
      if (commitment.observedAt >= ttlCutoff) {
        authorityCommitments[paneKey] = { ...commitment }
      }
    }
    for (const [paneKey, payload] of selectedStatusEntries(this.state.lastStatusByPaneKey, keys)) {
      // Why: never persist invalid keys (matches the hydrate-path invariant).
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const enrichedPayload = payload as EnrichedAgentHookEventPayload
      this.statusCacheExpiry.set(
        `entry\0${paneKey}`,
        !enrichedPayload.paneSleep && enrichedPayload.receivedAt >= ttlCutoff
          ? enrichedPayload.receivedAt + HYDRATE_MAX_AGE_MS
          : undefined
      )
      // Journal projections must not compete with unconfirmed copies hydrated from this cache.
      if (
        enrichedPayload.structuredHost ||
        (!enrichedPayload.paneSleep && enrichedPayload.receivedAt < ttlCutoff)
      ) {
        continue
      }
      const {
        promptInteractionKey: _promptInteractionKey,
        // Facets are stitched at publication; discard any copy that reached the map.
        programStatus: _programStatus,
        programStatusOnly: _programStatusOnly,
        agentIdentity: _agentIdentity,
        // Hydration restamps restoredUnconfirmed.
        restoredUnconfirmed: _restoredUnconfirmed,
        // Observation sequences belong to this runtime.
        observation: _observation,
        // Replay provenance is runtime-only and must not survive another restart.
        isReplay: _isReplay,
        // Terminal handles belong to this runtime and cannot safely rejoin a hydrated row.
        terminalHandle: _terminalHandle,
        hostTurnRevision: _hostTurnRevision,
        // Full replies serve this runtime's run records only.
        acceptedReply: _acceptedReply,
        launchToken: _launchToken,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      const { claudeTaskWakeupPending: _pendingWakeup, ...persistedStatus } =
        persistedPayload.payload
      entries[paneKey] = {
        ...persistedPayload,
        payload: persistedStatus,
        ...(launchTokenHash ? { launchTokenHash } : {})
      }
      const commitment = this.toAuthorityEvidence(persistedPayload, launchTokenHash)
      if (commitment && !conflictedCommitments.has(paneKey)) {
        const existing = authorityCommitments[paneKey]
        if (existing && !authorityCommitmentsMatch(existing, commitment)) {
          delete authorityCommitments[paneKey]
          conflictedCommitments.add(paneKey)
        } else {
          authorityCommitments[paneKey] = { ...commitment }
        }
      }
    }
    // Panes without successor agents would otherwise retain exit evidence forever.
    if (includeExits) {
      pruneAgentExits(this.agentExitedAtByPaneKey, ttlCutoff, (paneKey) =>
        this.state.lastStatusByPaneKey.has(paneKey)
      )
    }
    // Runtime keeps an old exit for a live row; the saved copy keeps it only beside a saved row.
    const agentExits = includeExits
      ? serializeAgentExits(this.agentExitedAtByPaneKey).filter(
          (exit) =>
            exit.at >= ttlCutoff ||
            exit.paneKeys.some((paneKey) => this.state.lastStatusByPaneKey.has(paneKey))
        )
      : []
    if (includeExits) {
      for (const [key, exit] of this.agentExitedAtByPaneKey) {
        this.statusCacheExpiry.set(
          `exit\0${key}`,
          exit.at >= ttlCutoff ? exit.at + HYDRATE_MAX_AGE_MS : undefined
        )
      }
    }
    return {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments,
      ...(agentExits.length > 0 ? { agentExits } : {})
    }
  }

  // Leading-edge throttling prevents event streams from postponing writes indefinitely (#26720).
  protected scheduleStatusPersist(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    const now = Date.now()
    // Persist authority changes immediately to preserve spool replay filtering after a crash.
    const urgent = this.currentAuthorityFingerprint() !== this.lastPersistedAuthorityFingerprint
    // A wall-clock rollback must not defer persistence indefinitely.
    const throttledAt = urgent
      ? now
      : Math.min(
          this.lastStatusPersistStartedAt + STATUS_PERSIST_MIN_INTERVAL_MS,
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
    return this.runStatusPersist(STATUS_FLUSH_BUSY_TIMEOUT_MS)
  }

  /** Writes only changed rows; a failure (including a held lock) retries with backoff. */
  protected runStatusPersist(busyTimeoutMs = 0): boolean {
    const store = this.getStatusStore()
    if (!store) {
      return true
    }
    if (store.isDisabled) {
      this.clearStatusPersistDebt()
      // Nothing reaches disk this session; flush callers must not read that as saved.
      return false
    }
    this.lastStatusPersistStartedAt = Date.now()
    const fingerprint = this.currentAuthorityFingerprint()
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
    } catch (err) {
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
    // Only a committed save can stand in for the authority it carries.
    this.lastPersistedAuthorityFingerprint = fingerprint
    this.statusPersistFailing = false
    this.statusPersistRetryDelayMs = 0
    this.statusPersistRetryAt = 0
    return true
  }

  private clearStatusPersistDebt(): void {
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
    return `${this.hydratedLaunchTokenHashByPaneKey.revision}:${this.persistedAuthorityCommitmentsByPaneKey.revision}:${this.statusAuthorityRevision}`
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
