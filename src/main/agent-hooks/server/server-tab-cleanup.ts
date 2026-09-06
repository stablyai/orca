import { clearPaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { paneCacheKeyMatchesTab } from './server-status-identity'
import { AgentHookServerCleanup } from './server-cleanup'

export abstract class AgentHookServerTabCleanup extends AgentHookServerCleanup {
  /** Drop every status/cache claim attributable to a closed tab prefix. */
  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.markTabClosedForAgentStatus(tabId)
    const paneKeysToClear = new Set<string>()
    for (const key of this.state.lastStatusByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
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
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (statusChanged || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  clearPaneState(paneKey: string): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const hadStatus = this.state.lastStatusByPaneKey.has(resolvedPaneKey)
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearCodexSubagentPoll(resolvedPaneKey)
    clearPaneCacheState(this.state, resolvedPaneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
    // Why: the pane itself is gone, so its observation clock describes nothing a later pane owns.
    this.evidenceObservedAtByPaneKey.delete(resolvedPaneKey)
    let clearedAlias = false
    for (const [legacyPaneKey, alias] of this.legacyPaneKeyAliases) {
      if (alias.stablePaneKey === resolvedPaneKey) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeys.add(legacyPaneKey)
        paneKeys.add(alias.stablePaneKey)
        clearPaneCacheState(this.state, legacyPaneKey)
        this.activeHookTurnCompletedAtByPaneKey.delete(legacyPaneKey)
        this.currentAuthorityObservations.delete(legacyPaneKey)
        this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
        this.restartedStatusLaunchTokenHashByPaneKey.delete(legacyPaneKey)
        this.evidenceObservedAtByPaneKey.delete(legacyPaneKey)
        clearedAlias = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (hadStatus || authorityChanged) {
      this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitPaneStatusCleared({ paneKey: resolvedPaneKey })
    }
  }
}
