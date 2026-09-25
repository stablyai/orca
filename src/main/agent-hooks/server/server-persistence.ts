import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { isValidPaneKey } from './server-status-identity'
import { LAST_STATUS_FILE_VERSION, STATUS_PERSIST_DEBOUNCE_MS } from './server-constants'
import type {
  EnrichedAgentHookEventPayload,
  LastStatusFile,
  PersistedAgentHookAuthorityCommitment,
  PersistedAgentHookEventPayload
} from './server-types'
import { authorityCommitmentsMatch } from './server-persistence-validation'
import { AgentHookServerHydration } from './server-hydration'

export abstract class AgentHookServerPersistence extends AgentHookServerHydration {
  protected pendingStatusPersist: Promise<void> | null = null
  private pendingStatusSnapshot: { json: string; directory: string; path: string } | null = null

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
        launchToken,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = launchToken?.trim()
        ? createHash('sha256').update(launchToken.trim()).digest('hex')
        : this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      // `payload.mainAgent` rides inside the payload; the legacy `claudeLeadBoundaryChildOnly` flag it
      // replaced is read at hydrate and never written again.
      entries[paneKey] = {
        ...persistedPayload,
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

  protected scheduleStatusPersist(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Why: reset the timer each call so the write fires only after the last event in a burst.
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
    }
    this.statusPersistTimer = setTimeout(() => {
      this.statusPersistTimer = null
      void this.runStatusPersist()
    }, STATUS_PERSIST_DEBOUNCE_MS)
    if (typeof this.statusPersistTimer.unref === 'function') {
      this.statusPersistTimer.unref()
    }
  }

  flushStatusPersist(): Promise<void> {
    if (this.statusPersistTimer) {
      clearTimeout(this.statusPersistTimer)
      this.statusPersistTimer = null
    }
    return this.runStatusPersist()
  }

  protected runStatusPersist(): Promise<void> {
    if (!this.lastStatusFilePath || !this.endpointDir) {
      return this.pendingStatusPersist ?? Promise.resolve()
    }
    this.pendingStatusSnapshot = {
      json: this.serializeStatusFile(),
      directory: this.endpointDir,
      path: this.lastStatusFilePath
    }
    if (!this.pendingStatusPersist) {
      this.pendingStatusPersist = this.drainStatusSnapshots()
    }
    return this.pendingStatusPersist
  }

  private async drainStatusSnapshots(): Promise<void> {
    await Promise.resolve()
    try {
      while (this.pendingStatusSnapshot) {
        const { json, directory, path } = this.pendingStatusSnapshot
        this.pendingStatusSnapshot = null
        if (json === this.lastWrittenJson) {
          continue
        }
        const tmpPath = join(directory, `.last-status-${process.pid}-${randomUUID()}.tmp`)
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          if (process.platform !== 'win32') {
            await chmod(directory, 0o700).catch(() => {})
          }
          await writeFile(tmpPath, json, { mode: 0o600 })
          await rename(tmpPath, path)
          this.lastWrittenJson = json
        } catch (err) {
          console.warn('[agent-hooks] failed to write last-status file:', err)
          await rm(tmpPath, { force: true }).catch(() => {})
          if (this.lastStatusFilePath === path) {
            this.scheduleStatusPersist()
          }
        }
      }
    } finally {
      this.pendingStatusPersist = null
    }
  }

  _resetPromptSentDedupeForTests(): void {
    this.promptSentDedupeByPaneKey.clear()
  }

  _resetConnectionTimestampWatermarksForTests(): void {
    this.connectionTimestampWatermarkById.clear()
  }
}
