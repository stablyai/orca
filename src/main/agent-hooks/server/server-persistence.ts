import { createHash } from 'node:crypto'

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
import { nextRetryDelayMs } from '../../sqlite/row-cache/row-cache-failure'

export abstract class AgentHookServerPersistence extends AgentHookServerHydration {
  private statusStore: LastStatusStore | null = null
  private statusStorePath: string | null = null
  private statusPersistFailing = false
  private statusPersistRetryDelayMs = 0
  private statusPersistRetryAt = 0

  protected buildStatusFile(): LastStatusFile {
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    // Restart drops anything older than the TTL, so saving it would only carry dead rows forward.
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, commitment] of this.persistedAuthorityCommitmentsByPaneKey) {
      if (commitment.observedAt >= ttlCutoff) {
        authorityCommitments[paneKey] = { ...commitment }
      }
    }
    for (const [paneKey, payload] of this.state.lastStatusByPaneKey) {
      // Why: never persist invalid keys (matches the hydrate-path invariant).
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const enrichedPayload = payload as EnrichedAgentHookEventPayload
      // Journal projections must not compete with unconfirmed copies hydrated from this cache.
      if (enrichedPayload.structuredHost || enrichedPayload.receivedAt < ttlCutoff) {
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
        launchToken,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = launchToken?.trim()
        ? createHash('sha256').update(launchToken.trim()).digest('hex')
        : this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      const { claudeTaskWakeupPending: _pendingWakeup, ...persistedStatus } =
        persistedPayload.payload
      entries[paneKey] = {
        ...persistedPayload,
        payload: persistedStatus,
        ...(launchTokenHash ? { launchTokenHash } : {})
      }
      const commitment = this.toAuthorityEvidence(payload, launchTokenHash)
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
    pruneAgentExits(this.agentExitedAtByPaneKey, ttlCutoff, (paneKey) =>
      this.state.lastStatusByPaneKey.has(paneKey)
    )
    // Runtime keeps an old exit for a live row; the saved copy keeps it only beside a saved row.
    const agentExits = serializeAgentExits(this.agentExitedAtByPaneKey).filter(
      (exit) =>
        exit.at >= ttlCutoff || exit.paneKeys.some((paneKey) => Object.hasOwn(entries, paneKey))
    )
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
      // Nothing reaches disk this session; flush callers must not read that as saved.
      return false
    }
    this.lastStatusPersistStartedAt = Date.now()
    const fingerprint = this.currentAuthorityFingerprint()
    try {
      store.write(this.buildStatusFile(), busyTimeoutMs)
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

  protected closeStatusSnapshotWriter(): void {
    this.cancelStatusPersistTimer()
    this.statusStore?.close()
    this.statusStore = null
    this.statusStorePath = null
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
    }
    return this.statusStore
  }

  /** Revision counters and live tokens avoid per-event hashing or serialization. */
  protected currentAuthorityFingerprint(): string {
    let fingerprint = `${this.hydratedLaunchTokenHashByPaneKey.revision}:${this.persistedAuthorityCommitmentsByPaneKey.revision}`
    for (const [paneKey, payload] of this.state.lastStatusByPaneKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
      const launchToken = (payload as EnrichedAgentHookEventPayload).launchToken?.trim()
      if (launchToken) {
        fingerprint += `\n${paneKey}\t${launchToken}`
      }
    }
    return fingerprint
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
