import { readFileSync } from 'node:fs'

import {
  seedClaudeLeadTurnFromPersistedStatus,
  seedClaudeSubagentRosterFromSnapshots
} from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import { seedCodexStateFromSnapshot } from '../../../shared/agent-hook-listener/providers/codex-state'
import { HYDRATE_MAX_AGE_MS, LAST_STATUS_FILE_VERSION } from './server-constants'
import type { LastStatusFile } from './server-types'
import {
  authorityCommitmentsMatch,
  dropHydratedIdleClaudeSubagents,
  readPersistedLaunchTokenHash,
  sanitizeHydratedEntry,
  sanitizePersistedAuthorityCommitment
} from './server-persistence-validation'
import { AgentHookServerReaping } from './server-reaping'

export abstract class AgentHookServerHydration extends AgentHookServerReaping {
  /** Hydrate the durable cache, validating every row before it reaches the live listener state. */
  protected hydrateLastStatusFromDisk(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Why: keep hydrate idempotent so a future re-start path can't merge prior-session state.
    this.state.lastStatusByPaneKey.clear()
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    let raw: string
    try {
      raw = readFileSync(this.lastStatusFilePath, 'utf8')
    } catch (err) {
      // Why: missing file is normal (first launch); other errors degrade to empty hydration + one warn.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-hooks] failed to read last-status file:', err)
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[agent-hooks] last-status file is not valid JSON; ignoring')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[agent-hooks] last-status file is not an object; ignoring')
      return
    }
    const file = parsed as Partial<LastStatusFile>
    if (file.version !== LAST_STATUS_FILE_VERSION) {
      console.warn(
        `[agent-hooks] last-status file version mismatch (${String(
          file.version
        )} != ${LAST_STATUS_FILE_VERSION}); ignoring`
      )
      return
    }
    const entries = file.entries
    if (typeof entries !== 'object' || entries === null) {
      console.warn('[agent-hooks] last-status file entries missing or wrong shape; ignoring')
      return
    }
    let hydrated = 0
    let dropped = 0
    let prunedLegacyClaudeSubagents = 0
    let scrubbedLegacyLaunchTokens = 0
    // Why: drop entries older than HYDRATE_MAX_AGE_MS to bound disk growth (one Date.now() for a consistent cutoff).
    const ttlCutoff = Date.now() - HYDRATE_MAX_AGE_MS
    for (const [paneKey, rawEntry] of Object.entries(entries)) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const rawResolvedEntry =
        resolvedPaneKey === paneKey || typeof rawEntry !== 'object' || rawEntry === null
          ? rawEntry
          : { ...(rawEntry as Record<string, unknown>), paneKey: resolvedPaneKey }
      const entry = sanitizeHydratedEntry(resolvedPaneKey, rawResolvedEntry)
      if (entry && entry.receivedAt >= ttlCutoff) {
        const launchTokenHash = readPersistedLaunchTokenHash(rawResolvedEntry)
        if (launchTokenHash) {
          this.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, launchTokenHash)
          const evidence = this.toAuthorityEvidence(entry, launchTokenHash)
          if (evidence) {
            this.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, evidence)
          }
        }
        if (
          typeof rawResolvedEntry === 'object' &&
          rawResolvedEntry !== null &&
          typeof (rawResolvedEntry as Record<string, unknown>).launchToken === 'string'
        ) {
          scrubbedLegacyLaunchTokens += 1
        }
        const hydratedPayload = dropHydratedIdleClaudeSubagents(entry.payload)
        if (hydratedPayload !== entry.payload) {
          prunedLegacyClaudeSubagents +=
            (entry.payload.subagents?.length ?? 0) - (hydratedPayload.subagents?.length ?? 0)
          entry.payload = hydratedPayload
        }
        if (entry.payload.state !== 'done') {
          // Why: the terminal transition may have fired while no receiver was up; restore as unconfirmed, never as live truth.
          entry.restoredUnconfirmed = true
        }
        this.state.lastStatusByPaneKey.set(resolvedPaneKey, entry)
        if (entry.connectionId) {
          // Why: a restart can see an earlier wall clock; seed ordering so new events stay after disk state.
          const previousWatermark = this.connectionTimestampWatermarkById.get(entry.connectionId)
          this.connectionTimestampWatermarkById.set(
            entry.connectionId,
            Math.max(previousWatermark ?? -1, entry.receivedAt)
          )
        }
        // Why: restore live child hierarchy immediately; provider-specific reconciliation reaps stale seeds.
        if (entry.payload.agentType === 'codex') {
          seedCodexStateFromSnapshot(this.state, resolvedPaneKey, entry.payload)
        } else if (entry.payload.agentType === 'claude') {
          seedClaudeLeadTurnFromPersistedStatus(this.state, resolvedPaneKey, entry, {
            childOnlyBoundary: entry.claudeLeadBoundaryChildOnly === true
          })
          if (entry.payload.subagents) {
            seedClaudeSubagentRosterFromSnapshots(
              this.state,
              resolvedPaneKey,
              entry.payload.subagents
            )
          }
        }
        hydrated += 1
      } else {
        dropped += 1
      }
    }
    for (const [paneKey, rawCommitment] of Object.entries(file.authorityCommitments ?? {})) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      const commitment = sanitizePersistedAuthorityCommitment(resolvedPaneKey, rawCommitment)
      if (!commitment || commitment.observedAt < ttlCutoff) {
        dropped += 1
        continue
      }
      const existing = this.persistedAuthorityCommitmentsByPaneKey.get(resolvedPaneKey)
      if (existing && !authorityCommitmentsMatch(existing, commitment)) {
        this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
        this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
        dropped += 1
        continue
      }
      this.persistedAuthorityCommitmentsByPaneKey.set(resolvedPaneKey, commitment)
      this.hydratedLaunchTokenHashByPaneKey.set(resolvedPaneKey, commitment.launchTokenHash)
    }
    if (dropped > 0) {
      console.warn(
        `[agent-hooks] last-status hydrate dropped ${dropped} entries (kept ${hydrated})`
      )
    }
    if (dropped > 0 || prunedLegacyClaudeSubagents > 0 || scrubbedLegacyLaunchTokens > 0) {
      // Why: persist load-time pruning and bearer scrubbing once.
      this.runStatusPersist()
    } else if (hydrated > 0) {
      // Why: prime dedup from raw bytes (not re-serialized) only when hydration was lossless.
      this.lastWrittenJson = raw
    }
  }
}
