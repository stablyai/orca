import { createHash } from 'node:crypto'

import { isValidPaneKey } from './server-status-identity'
import {
  HYDRATE_MAX_AGE_MS,
  LAST_STATUS_FILE_VERSION,
  STATUS_PERSIST_MIN_INTERVAL_MS
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
import { AtomicSnapshotWriter } from '../../persistence/atomic-snapshot-writer'

export abstract class AgentHookServerPersistence extends AgentHookServerHydration {
  private statusSnapshotWriter: AtomicSnapshotWriter | null = null
  private statusSnapshotWriterPath: string | null = null
  private statusPersistFailing = false

  protected serializeStatusFile(): string {
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    for (const [paneKey, commitment] of this.persistedAuthorityCommitmentsByPaneKey) {
      authorityCommitments[paneKey] = { ...commitment }
    }
    for (const [paneKey, payload] of this.state.lastStatusByPaneKey) {
      // Why: never persist invalid keys (matches the hydrate-path invariant).
      if (!isValidPaneKey(paneKey)) {
        continue
      }
      const enrichedPayload = payload as EnrichedAgentHookEventPayload
      // Journal projections must not compete with unconfirmed copies hydrated from this cache.
      if (enrichedPayload.structuredHost) {
        continue
      }
      const {
        promptInteractionKey: _promptInteractionKey,
        // Facets are stitched at publication; discard any copy that reached the map.
        programStatus: _programStatus,
        programStatusOnly: _programStatusOnly,
        // Hydration restamps restoredUnconfirmed.
        restoredUnconfirmed: _restoredUnconfirmed,
        // Observation sequences belong to this runtime.
        observation: _observation,
        // Replay provenance is runtime-only and must not survive another restart.
        isReplay: _isReplay,
        // Terminal handles belong to this runtime and cannot safely rejoin a hydrated row.
        terminalHandle: _terminalHandle,
        hostTurnRevision: _hostTurnRevision,
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
    pruneAgentExits(this.agentExitedAtByPaneKey, Date.now() - HYDRATE_MAX_AGE_MS, (paneKey) =>
      this.state.lastStatusByPaneKey.has(paneKey)
    )
    const agentExits = serializeAgentExits(this.agentExitedAtByPaneKey)
    const file: LastStatusFile = {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments,
      ...(agentExits.length > 0 ? { agentExits } : {})
    }
    return JSON.stringify(file)
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
    const dueAt = urgent
      ? now
      : Math.min(
          this.lastStatusPersistStartedAt + STATUS_PERSIST_MIN_INTERVAL_MS,
          now + STATUS_PERSIST_MIN_INTERVAL_MS
        )
    if (this.statusPersistTimer) {
      if (dueAt >= this.statusPersistDueAt) {
        return
      }
      clearTimeout(this.statusPersistTimer)
    }
    this.statusPersistDueAt = Math.max(dueAt, now)
    this.statusPersistTimer = setTimeout(() => {
      this.statusPersistTimer = null
      this.startStatusPersist()
    }, this.statusPersistDueAt - now)
    // Quit flushes synchronously; this timer must not keep the runtime alive.
    if (typeof this.statusPersistTimer.unref === 'function') {
      this.statusPersistTimer.unref()
    }
  }

  flushStatusPersistSync(): void {
    this.cancelStatusPersistTimer()
    if (!this.lastStatusFilePath) {
      return
    }
    this.runStatusPersist()
  }

  /** Quit, hook-disable and hydration repair need synchronous writes; routine updates are async. */
  protected runStatusPersist(): void {
    const writer = this.getStatusSnapshotWriter()
    if (!writer) {
      return
    }
    this.lastStatusPersistStartedAt = Date.now()
    this.lastPersistedAuthorityFingerprint = this.currentAuthorityFingerprint()
    try {
      writer.writeSync(() => this.serializeStatusFile())
      this.statusPersistFailing = false
    } catch (err) {
      this.reportStatusPersistFailure(err)
    }
  }

  protected primeStatusPersistBaseline(onDiskJson: string): void {
    this.getStatusSnapshotWriter()?.primeCommittedContent(onDiskJson)
    this.lastPersistedAuthorityFingerprint = this.currentAuthorityFingerprint()
  }

  protected closeStatusSnapshotWriter(): void {
    this.cancelStatusPersistTimer()
    this.statusSnapshotWriter?.close()
    this.statusSnapshotWriter = null
    this.statusSnapshotWriterPath = null
    this.lastStatusPersistStartedAt = Number.NEGATIVE_INFINITY
    this.lastPersistedAuthorityFingerprint = null
    this.statusPersistFailing = false
  }

  protected getStatusSnapshotWriter(): AtomicSnapshotWriter | null {
    const filePath = this.lastStatusFilePath
    if (!filePath) {
      return null
    }
    if (!this.statusSnapshotWriter || this.statusSnapshotWriterPath !== filePath) {
      this.statusSnapshotWriter?.close()
      this.statusSnapshotWriter = new AtomicSnapshotWriter(() => filePath, {
        fileMode: 0o600,
        directoryMode: 0o700,
        skipUnchanged: true
      })
      this.statusSnapshotWriterPath = filePath
    }
    return this.statusSnapshotWriter
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

  private startStatusPersist(): void {
    const writer = this.getStatusSnapshotWriter()
    if (!writer) {
      return
    }
    this.lastStatusPersistStartedAt = Date.now()
    this.lastPersistedAuthorityFingerprint = this.currentAuthorityFingerprint()
    writer
      .write(() => this.serializeStatusFile())
      .then(
        () => {
          this.statusPersistFailing = false
        },
        (err: unknown) => {
          if (this.statusSnapshotWriter !== writer) {
            return
          }
          this.reportStatusPersistFailure(err)
          // Retry even if no later mutation arrives.
          this.scheduleStatusPersist()
        }
      )
  }

  private cancelStatusPersistTimer(): void {
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
      this.statusPersistTimer = null
    }
  }

  private reportStatusPersistFailure(err: unknown): void {
    if (!this.statusPersistFailing) {
      console.warn('[agent-hooks] failed to write last-status file:', err)
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
