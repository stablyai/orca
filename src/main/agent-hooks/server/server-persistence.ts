import { createHash } from 'node:crypto'

import { isValidPaneKey } from './server-status-identity'
import { LAST_STATUS_FILE_VERSION, STATUS_PERSIST_MIN_INTERVAL_MS } from './server-constants'
import type {
  EnrichedAgentHookEventPayload,
  LastStatusFile,
  PersistedAgentHookAuthorityCommitment,
  PersistedAgentHookEventPayload
} from './server-types'
import { authorityCommitmentsMatch } from './server-persistence-validation'
import { AgentHookServerHydration } from './server-hydration'
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
      // Why: the session journal is the durable truth for a structured row and the host republishes
      // it on restore; a persisted copy would hydrate unconfirmed and fight that republish.
      if (enrichedPayload.structuredHost) {
        continue
      }
      const {
        promptInteractionKey: _promptInteractionKey,
        // Why: never persisted — hydrate re-stamps it, so a stored copy could only drift.
        restoredUnconfirmed: _restoredUnconfirmed,
        // Why: same — the sequencer that issued it dies with the process (see PersistedAgentHookEventPayload).
        observation: _observation,
        // Replay provenance is runtime-only and must not survive another restart.
        isReplay: _isReplay,
        // A terminal handle belongs to the runtime that issued it; a hydrated one could only
        // rejoin a row to somebody else's terminal.
        terminalHandle: _terminalHandle,
        hostTurnRevision: _hostTurnRevision,
        launchToken,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = launchToken?.trim()
        ? createHash('sha256').update(launchToken.trim()).digest('hex')
        : this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      // `payload.mainAgent` rides inside the payload; the legacy `claudeLeadBoundaryChildOnly` flag it
      // replaced is read at hydrate and never written again.
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
    const file: LastStatusFile = {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments
    }
    return JSON.stringify(file)
  }

  // Why: leading-edge throttle — an isolated change is written on the next turn, while a stream of
  // changes gets at most one write per window and cannot postpone it (#26720).
  protected scheduleStatusPersist(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    const now = Date.now()
    // Why: authority loss after a crash weakens the spool token filter, so it skips the window.
    const urgent = this.currentAuthorityFingerprint() !== this.lastPersistedAuthorityFingerprint
    // Why: clamp so a wall-clock rollback can't push the next write far into the future.
    const dueAt = urgent
      ? now
      : Math.min(
          this.lastStatusPersistStartedAt + STATUS_PERSIST_MIN_INTERVAL_MS,
          now + STATUS_PERSIST_MIN_INTERVAL_MS
        )
    if (this.statusPersistTimer) {
      // Why: never push an armed write back; only pull it forward for urgent work.
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
    // Why: don't keep the event loop alive just for a status flush — quit already flushes sync.
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

  /** Synchronous write for quit, hook-disable and hydration repair; ordinary updates use the async path. */
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

  /** Cheap per-event check: revision counters plus live launch tokens, no hashing or serialization. */
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
          // Why: the failed state may never be followed by another mutation; retry next window.
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
    // Why: one warning per failure streak, not one per hook event.
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
