import { clearPaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { paneCacheKeyMatchesTab } from './server-status-identity'
import { AgentHookServerCleanup } from './server-cleanup'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { releaseAgentExitKey } from './agent-exit-evidence'

export abstract class AgentHookServerTabCleanup extends AgentHookServerCleanup {
  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.markTabClosedForAgentStatus(tabId)
    this.clearTmuxTabSubjects(tabId)
    const paneKeysToClear = new Set<string>()
    const statusPaneKeysToClear = new Set<string>()
    const statusRowsToClear: EnrichedAgentHookEventPayload[] = []
    for (const key of this.state.lastStatusByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
        statusPaneKeysToClear.add(key)
        const row = this.state.lastStatusByPaneKey.get(key) as
          | EnrichedAgentHookEventPayload
          | undefined
        if (row) {
          statusRowsToClear.push(row)
        }
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
      this.clearTranscriptPoll(paneKey)
      clearPaneCacheState(this.state, paneKey)
      this.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
      this.runtimeObservedStatusPaneKeys.delete(paneKey)
      this.currentAuthorityObservations.delete(paneKey)
      this.promptSentDedupeByPaneKey.delete(paneKey)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
      this.evidenceObservedAtByPaneKey.delete(paneKey)
      this.programStatusFacets.delete(paneKey)
      this.hookSilenceRechecks.cancel(paneKey)
      this.programStatusFacetRepublishes.cancel(paneKey)
    }
    // Exits outlive their rows; match tab identity independently of cleared status keys.
    let exitsChanged = false
    for (const key of this.agentExitedAtByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        exitsChanged = releaseAgentExitKey(this.agentExitedAtByPaneKey, key) || exitsChanged
      }
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
    } else if (exitsChanged) {
      this.scheduleStatusPersist()
    }
    // Subscribers must release pane-scoped state when the tab closes.
    for (const paneKey of statusPaneKeysToClear) {
      this.emitPaneStatusCleared({ paneKey })
    }
  }

  clearPaneState(
    paneKey: string,
    options?: {
      emitStatusRowMutation?: boolean
      preserveTmuxInnerSubjects?: boolean
      statusUnavailable?: true
      /** The pane's PTY is retired, not just its agent. */
      forgetAgentExit?: true
    }
  ): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    if (options?.forgetAgentExit) {
      this.forgetAgentExit(paneKey)
    }
    if (!options?.preserveTmuxInnerSubjects) {
      this.clearTmuxInnerSubjects(resolvedPaneKey)
    }
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const previousStatus = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const hadStatus = previousStatus !== undefined
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearTranscriptPoll(resolvedPaneKey)
    clearPaneCacheState(this.state, resolvedPaneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
    // A retired pane's evidence clock cannot belong to its successor.
    this.evidenceObservedAtByPaneKey.delete(resolvedPaneKey)
    this.programStatusFacets.delete(resolvedPaneKey)
    this.hookSilenceRechecks.cancel(resolvedPaneKey)
    this.programStatusFacetRepublishes.cancel(resolvedPaneKey)
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
        this.programStatusFacets.delete(legacyPaneKey)
        clearedAlias = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (options?.emitStatusRowMutation !== false) {
      this.commitStatusRowMutation(previousStatus, undefined)
    }
    if (hadStatus || authorityChanged) {
      this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitPaneStatusCleared({
        paneKey: resolvedPaneKey,
        statusUnavailable: options?.statusUnavailable
      })
    }
  }
}
