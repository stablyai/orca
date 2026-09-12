import { clearPaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { paneCacheKeyMatchesTab } from './server-status-identity'
import { AgentHookServerCleanup } from './server-cleanup'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerTabCleanup extends AgentHookServerCleanup {
  /** Drop every status/cache claim attributable to a closed tab prefix. */
  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.markTabClosedForAgentStatus(tabId)
    const paneKeysToClear = new Set<string>()
    const statusPaneKeysToClear = new Set<string>()
    const statusRowsToClear: EnrichedAgentHookEventPayload[] = []
    for (const [key, rawRow] of this.state.lastStatusByPaneKey) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
        const row = rawRow as EnrichedAgentHookEventPayload
        paneKeysToClear.add(row.paneKey)
        statusPaneKeysToClear.add(row.paneKey)
        statusRowsToClear.push(row)
      }
    }
    for (const key of this.state.lastPromptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.lastToolByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.antigravityCompletedTranscriptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.ampCompletedCacheKeys) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const paneKey of this.runtimeObservedStatusPaneKeys) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const paneKey of this.promptSentDedupeByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (paneCacheKeyMatchesTab(commitment.paneKey, tabId)) {
        paneKeysToClear.add(commitment.paneKey)
      }
    }
    let aliasChanged = false
    for (const [legacyPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (paneCacheKeyMatchesTab(entry.stablePaneKey, tabId)) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeysToClear.add(legacyPaneKey)
        paneKeysToClear.add(entry.stablePaneKey)
        this.markPaneClosedForAgentStatus(legacyPaneKey)
        this.markPaneClosedForAgentStatus(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeysToClear)
    let statusChanged = false
    for (const paneKey of paneKeysToClear) {
      if (this.state.lastStatusByPaneKey.has(paneKey)) {
        statusChanged = true
      }
      this.clearAssistantMessageRetry(paneKey)
      this.clearCodexSubagentPoll(paneKey)
      clearPaneCacheState(this.state, paneKey)
      this.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
      this.runtimeObservedStatusPaneKeys.delete(paneKey)
      this.currentAuthorityObservations.delete(paneKey)
      this.promptSentDedupeByPaneKey.delete(paneKey)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
      this.evidenceObservedAtByPaneKey.delete(paneKey)
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    for (const row of statusRowsToClear) {
      this.commitStatusRowMutation(row, undefined)
    }
    if (statusChanged || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    // Why: tab teardown must retire status subscribers' pane-scoped memo state too.
    for (const paneKey of statusPaneKeysToClear) {
      this.emitPaneStatusCleared({ paneKey })
    }
  }

  clearPaneState(paneKey: string, options?: { emitStatusRowMutation?: boolean }): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    const statusKeys = new Set(this.statusKeysForPaneKey(resolvedPaneKey))
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const previousStatuses = Array.from(statusKeys).flatMap((statusKey) => {
      const entry = this.state.lastStatusByPaneKey.get(statusKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      return entry ? [entry] : []
    })
    const hadStatus = previousStatuses.length > 0
    let clearedAlias = false
    for (const [legacyPaneKey, alias] of this.legacyPaneKeyAliases) {
      if (alias.stablePaneKey === resolvedPaneKey) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeys.add(legacyPaneKey)
        paneKeys.add(alias.stablePaneKey)
        for (const statusKey of this.statusKeysForPaneKey(legacyPaneKey)) {
          statusKeys.add(statusKey)
        }
        clearedAlias = true
      }
    }
    for (const statusKey of statusKeys) {
      this.clearAssistantMessageRetry(statusKey)
      this.clearCodexSubagentPoll(statusKey)
      clearPaneCacheState(this.state, statusKey)
      this.activeHookTurnCompletedAtByPaneKey.delete(statusKey)
      this.currentAuthorityObservations.delete(statusKey)
      this.promptSentDedupeByPaneKey.delete(statusKey)
      this.evidenceObservedAtByPaneKey.delete(statusKey)
      this.runtimeObservedStatusPaneKeys.delete(statusKey)
    }
    for (const legacyPaneKey of paneKeys) {
      // Legacy unscoped cache entries can survive a version upgrade until their next event.
      clearPaneCacheState(this.state, legacyPaneKey)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(legacyPaneKey)
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (options?.emitStatusRowMutation !== false) {
      for (const previousStatus of previousStatuses) {
        this.commitStatusRowMutation(previousStatus, undefined)
      }
    }
    if (hadStatus || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitPaneStatusCleared({ paneKey: resolvedPaneKey })
    }
  }
}
