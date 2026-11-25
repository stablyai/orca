import { isValidPaneKey } from './server-status-identity'
import { AGENT_STATUS_HYDRATE_MAX_AGE_MS as HYDRATE_MAX_AGE_MS } from '../../../shared/agent-status/contracts/agent-status-freshness'
import { LAST_STATUS_FILE_VERSION } from './server-constants'
import type {
  EnrichedAgentHookEventPayload,
  LastStatusFile,
  PersistedAgentHookAuthorityCommitment,
  PersistedAgentHookEventPayload
} from './server-types'
import { authorityCommitmentsMatch } from './server-persistence-validation'
import { AgentHookServerHydration } from './server-hydration'
import { pruneAgentExits, serializeAgentExits } from './agent-exit-evidence'
import { KeyedDeadlines } from '../../../shared/collections/keyed-deadlines'
import { selectedStatusEntries } from './last-status-saved-rows'

/** The saved last-status document for some or all panes; the save path decides which panes. */
export abstract class AgentHookServerStatusFile extends AgentHookServerHydration {
  protected readonly statusCacheExpiry = new KeyedDeadlines()

  protected buildStatusFile(keys?: readonly string[], includeExits = true): LastStatusFile {
    if (!keys) {
      this.statusCacheExpiry.clear()
    }
    const entries: Record<string, PersistedAgentHookEventPayload> = {}
    const authorityCommitments: Record<string, PersistedAgentHookAuthorityCommitment> = {}
    const conflictedCommitments = new Set<string>()
    // Restart drops rows older than the TTL unless a placed pane still holds them.
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
        (!enrichedPayload.paneSleep &&
          enrichedPayload.receivedAt < ttlCutoff &&
          !this.placementKeepsRow(enrichedPayload))
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
        // Only a shared host outlives the restart; a pane-owned claim is proven again by its hook.
        executionHost: _executionHost,
        ...persistedPayload
      } = enrichedPayload
      const launchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
      const { claudeTaskWakeupPending: _pendingWakeup, ...persistedStatus } =
        persistedPayload.payload
      entries[paneKey] = {
        ...persistedPayload,
        payload: persistedStatus,
        ...(launchTokenHash ? { launchTokenHash } : {}),
        ...(enrichedPayload.executionHost === 'shared' ? { executionHost: 'shared' as const } : {})
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
}
