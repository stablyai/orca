import {
  admitLegacyAgentStatus,
  clearLegacyAgentStatuses
} from '../../../shared/agent-hook-listener/listener-state'
import {
  seedClaudeLeadTurnFromPersistedStatus,
  seedClaudeSubagentRosterFromSnapshots
} from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-roster-state'
import { seedCodexStateFromSnapshot } from '../../../shared/agent-hook-listener/providers/codex/codex-state'
import { AGENT_STATUS_PERSISTED_HYDRATION_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'
import { AGENT_STATUS_HYDRATE_MAX_AGE_MS as HYDRATE_MAX_AGE_MS } from '../../../shared/agent-status/contracts/agent-status-freshness'
import { LAST_STATUS_FILE_VERSION, STATUS_FLUSH_BUSY_TIMEOUT_MS } from './server-constants'
import type { SavedStatus } from './last-status-store'
import type { EnrichedAgentHookEventPayload, LastStatusFile } from './server-types'
import {
  authorityCommitmentsMatch,
  dropHydratedIdleClaudeSubagents,
  readPersistedLaunchTokenHash,
  sanitizeHydratedEntry,
  sanitizePersistedAuthorityCommitment
} from './server-persistence-validation'
import { AgentHookServerTabCleanup } from './server-tab-cleanup'
import { readPersistedAgentExits, recordAgentExit } from './agent-exit-evidence'

export abstract class AgentHookServerHydration extends AgentHookServerTabCleanup {
  protected hydrateLastStatusFromDisk(): void {
    if (!this.lastStatusFilePath) {
      return
    }
    // Repeated hydration must not merge state from an earlier runtime.
    this.providerRowsByTab = null
    clearLegacyAgentStatuses(this.state)
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    const store = this.getStatusStore()
    let saved: SavedStatus | undefined
    try {
      saved = store?.read(STATUS_FLUSH_BUSY_TIMEOUT_MS)
    } catch (err) {
      // Status is a restart cache; an unreadable store degrades to empty hydration + one warn.
      // The store then stays read-only for this session, so rows it never read survive.
      console.warn('[agent-hooks] failed to read saved agent status:', err)
      return
    }
    if (!store || !saved) {
      return
    }
    if (saved.source === 'legacy') {
      if (this.admitSavedStatus(saved.document)) {
        // Only an admitted file is recorded as imported, once rows holding it commit.
        store.confirmLegacyImport()
      } else {
        // A rejected file must not stand in for the rows: drop it and restore those instead.
        store.rejectLegacy()
        const rows = store.readRows()
        if (rows) {
          this.admitSavedStatus(rows.document)
        }
      }
    } else {
      this.admitSavedStatus(saved.document)
    }
    // Repairs and a migrated legacy file are saved now; an unchanged store writes nothing.
    this.runStatusPersist()
  }

  /** False when the document is rejected whole; nothing from it is admitted then. */
  private admitSavedStatus(parsed: unknown): boolean {
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[agent-hooks] last-status file is not an object; ignoring')
      return false
    }
    const file = parsed as Partial<LastStatusFile>
    if (file.version !== LAST_STATUS_FILE_VERSION) {
      console.warn(
        `[agent-hooks] last-status file version mismatch (${String(
          file.version
        )} != ${LAST_STATUS_FILE_VERSION}); ignoring`
      )
      return false
    }
    const entries = file.entries
    if (typeof entries !== 'object' || entries === null) {
      console.warn('[agent-hooks] last-status file entries missing or wrong shape; ignoring')
      return false
    }
    let hydrated = 0
    let dropped = 0
    let prunedLegacyClaudeSubagents = 0
    let scrubbedLegacyLaunchTokens = 0
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
          // Completion may have occurred offline; restored work needs confirmation.
          entry.restoredUnconfirmed = true
        }
        admitLegacyAgentStatus(
          this.state,
          'main-status-hydration',
          entry,
          AGENT_STATUS_PERSISTED_HYDRATION_MODE
        )
        if (entry.connectionId) {
          // Seed ordering from disk even if the wall clock moved backward.
          const previousWatermark = this.connectionTimestampWatermarkById.get(entry.connectionId)
          this.connectionTimestampWatermarkById.set(
            entry.connectionId,
            Math.max(previousWatermark ?? -1, entry.receivedAt)
          )
        }
        // Seed child hierarchy now; provider reconciliation removes stale entries.
        if (entry.payload.agentType === 'codex') {
          seedCodexStateFromSnapshot(this.state, resolvedPaneKey, entry.payload)
        } else if (entry.payload.agentType === 'claude') {
          seedClaudeLeadTurnFromPersistedStatus(this.state, resolvedPaneKey, entry)
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
    for (const exit of readPersistedAgentExits(file.agentExits, ttlCutoff)) {
      recordAgentExit(this.agentExitedAtByPaneKey, exit.paneKeys, exit, exit.at)
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
    return true
  }

  listUnconfirmedRestoredStatuses(): EnrichedAgentHookEventPayload[] {
    const rows: EnrichedAgentHookEventPayload[] = []
    for (const [paneKey, row] of this.state.lastStatusByPaneKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
      const enriched = row as EnrichedAgentHookEventPayload
      // Resume identity alone makes no work claim.
      if (
        enriched.restoredUnconfirmed &&
        !enriched.providerSessionOnly &&
        !this.runtimeObservedStatusPaneKeys.has(paneKey)
      ) {
        rows.push(enriched)
      }
    }
    return rows
  }
}
