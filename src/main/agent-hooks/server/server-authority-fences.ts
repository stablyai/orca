import { clearPaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { AgentHookServerAuthorityAliases } from './server-authority-aliases'
import type {
  EnrichedAgentHookEventPayload,
  RetiredPaneAlias,
  RetiredPaneFence
} from './server-types'

export abstract class AgentHookServerAuthorityFences extends AgentHookServerAuthorityAliases {
  retirePaneAuthority(paneKey: string, retirementId?: string): void {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    const previousFence = this.retiredPaneFencesByKey.get(ownerPaneKey)
    const paneKeys = new Set([paneKey, ownerPaneKey])
    for (const key of previousFence?.paneKeys ?? []) {
      if (
        this.retiredPaneFencesByKey.get(key) === previousFence &&
        this.closedAgentStatusPaneKeys.has(key)
      ) {
        paneKeys.add(key)
      }
    }
    const retiredAliases: RetiredPaneAlias[] = (previousFence?.aliases ?? []).filter(
      ({ physicalPaneKey, entry }) =>
        paneKeys.has(physicalPaneKey) && paneKeys.has(entry.stablePaneKey)
    )
    let aliasChanged = false
    for (const [physicalPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (physicalPaneKey === paneKey || entry.stablePaneKey === ownerPaneKey) {
        this.legacyPaneKeyAliases.delete(physicalPaneKey)
        retiredAliases.push({ physicalPaneKey, entry })
        paneKeys.add(physicalPaneKey)
        paneKeys.add(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    this.recordRetiredPaneFence(
      paneKeys,
      retiredAliases,
      this.isClosedAgentStatusTabForPaneKey(ownerPaneKey) ? undefined : retirementId
    )
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    const retiredRows = [...paneKeys].flatMap((key) => {
      const row = this.state.lastStatusByPaneKey.get(key) as
        | EnrichedAgentHookEventPayload
        | undefined
      return row ? [row] : []
    })
    const hadStatus = retiredRows.length > 0
    for (const key of paneKeys) {
      this.clearTmuxInnerSubjects(key)
      this.markPaneClosedForAgentStatus(key)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(key)
      this.clearAssistantMessageRetry(key)
      this.clearTranscriptPoll(key)
      clearPaneCacheState(this.state, key)
      this.activeHookTurnCompletedAtByPaneKey.delete(key)
      this.runtimeObservedStatusPaneKeys.delete(key)
      this.currentAuthorityObservations.delete(key)
      this.promptSentDedupeByPaneKey.delete(key)
      this.observations.forget(key)
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    for (const row of retiredRows) {
      this.commitStatusRowMutation(row, undefined)
    }
    if (hadStatus || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  // Restore the full alias fence; detached processes still post old keys, but closed tabs stay fenced.
  protected restoreRetiredPaneFence(fence: RetiredPaneFence): void {
    let aliasChanged = false
    for (const { physicalPaneKey, entry } of fence.aliases) {
      if (
        this.retiredPaneFencesByKey.get(physicalPaneKey) !== fence ||
        this.retiredPaneFencesByKey.get(entry.stablePaneKey) !== fence ||
        this.isClosedAgentStatusTabForPaneKey(physicalPaneKey) ||
        this.isClosedAgentStatusTabForPaneKey(entry.stablePaneKey) ||
        // A newer binding supersedes the retired alias.
        this.legacyPaneKeyAliases.has(physicalPaneKey)
      ) {
        continue
      }
      this.legacyPaneKeyAliases.set(physicalPaneKey, entry)
      aliasChanged = true
    }
    for (const key of fence.paneKeys) {
      if (this.retiredPaneFencesByKey.get(key) === fence) {
        this.retiredPaneFencesByKey.delete(key)
      }
    }
    if (aliasChanged) {
      this.boundPaneKeyAliases()
      this.notifyPaneKeyAliasPersistenceListener()
    }
  }

  restorePaneAuthority(paneKey: string): boolean {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    if (this.isClosedAgentStatusTabForPaneKey(ownerPaneKey)) {
      return false
    }
    // Reattachment disproves pane retirement immediately; idle agents may never post another hook (STA-4114).
    const fence =
      this.retiredPaneFencesByKey.get(paneKey) ?? this.retiredPaneFencesByKey.get(ownerPaneKey)
    let restored = false
    for (const key of new Set([paneKey, ownerPaneKey, ...(fence?.paneKeys ?? [])])) {
      if (
        (fence && this.retiredPaneFencesByKey.get(key) !== fence) ||
        this.isClosedAgentStatusTabForPaneKey(key)
      ) {
        continue
      }
      if (this.closedAgentStatusPaneKeys.delete(key)) {
        restored = true
      }
    }
    if (fence) {
      this.restoreRetiredPaneFence(fence)
    }
    return restored
  }

  protected restoreRetiredStatusRestart(paneKey: string): {
    paneKey: string
    authorityRestartId?: string
  } {
    const authorityRestartId = this.takeRetiredPaneRestartId(paneKey)
    if (!authorityRestartId) {
      return { paneKey }
    }
    this.restorePaneAuthority(paneKey)
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    if (ownerPaneKey !== paneKey) {
      const tokenHash = this.restartedStatusLaunchTokenHashByPaneKey.get(paneKey)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
      if (tokenHash) {
        this.restartedStatusLaunchTokenHashByPaneKey.set(ownerPaneKey, tokenHash)
      }
    }
    return { paneKey: ownerPaneKey, authorityRestartId }
  }

  clearPaneKeyAliasesForPty(
    ptyId: string,
    options?: { shouldClearStablePaneKey?: (paneKey: string) => boolean }
  ): void {
    let aliasChanged = false
    let statusChanged = false
    const clearedStatusPaneKeys = new Set<string>()
    const clearedStatusRows = new Map<string, EnrichedAgentHookEventPayload>()
    for (const [legacyPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (entry.ptyId !== ptyId) {
        continue
      }
      const shouldClearStablePaneKey =
        options?.shouldClearStablePaneKey?.(entry.stablePaneKey) ?? true
      const revokedPaneKeys = new Set([legacyPaneKey])
      if (shouldClearStablePaneKey) {
        revokedPaneKeys.add(entry.stablePaneKey)
      }
      if (this.revokeHydratedAuthorityForPaneKeys(revokedPaneKeys)) {
        statusChanged = true
      }
      this.legacyPaneKeyAliases.delete(legacyPaneKey)
      clearPaneCacheState(this.state, legacyPaneKey)
      this.activeHookTurnCompletedAtByPaneKey.delete(legacyPaneKey)
      this.currentAuthorityObservations.delete(legacyPaneKey)
      this.promptSentDedupeByPaneKey.delete(legacyPaneKey)
      if (shouldClearStablePaneKey && this.state.lastStatusByPaneKey.has(entry.stablePaneKey)) {
        statusChanged = true
        clearedStatusPaneKeys.add(entry.stablePaneKey)
        clearedStatusRows.set(
          entry.stablePaneKey,
          this.state.lastStatusByPaneKey.get(entry.stablePaneKey) as EnrichedAgentHookEventPayload
        )
      }
      if (shouldClearStablePaneKey) {
        // Hydrated PTYs may lack ptyPaneKey; alias cleanup must evict their stable rows.
        clearPaneCacheState(this.state, entry.stablePaneKey)
        this.activeHookTurnCompletedAtByPaneKey.delete(entry.stablePaneKey)
        this.runtimeObservedStatusPaneKeys.delete(entry.stablePaneKey)
        this.currentAuthorityObservations.delete(entry.stablePaneKey)
        this.promptSentDedupeByPaneKey.delete(entry.stablePaneKey)
      }
      aliasChanged = true
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    for (const row of clearedStatusRows.values()) {
      this.commitStatusRowMutation(row, undefined)
    }
    if (statusChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      for (const paneKey of clearedStatusPaneKeys) {
        this.emitPaneStatusCleared({ paneKey })
      }
    }
  }

  protected resolvePaneKeyAlias(paneKey: string): string {
    return this.legacyPaneKeyAliases.get(paneKey)?.stablePaneKey ?? paneKey
  }

  protected revokeHydratedAuthorityForPaneKeys(paneKeys: ReadonlySet<string>): boolean {
    let changed = false
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (
        paneKeys.has(commitment.paneKey) ||
        paneKeys.has(this.resolvePaneKeyAlias(commitment.paneKey))
      ) {
        this.revokedHydratedAuthorityCommitments.add(commitment)
        changed = true
      }
    }
    for (const paneKey of paneKeys) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      changed = this.hydratedLaunchTokenHashByPaneKey.delete(paneKey) || changed
      changed = this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey) || changed
      changed = this.persistedAuthorityCommitmentsByPaneKey.delete(paneKey) || changed
      changed = this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey) || changed
    }
    return changed
  }

  protected normalizeHookBodyPaneKeyAlias(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) {
      return body
    }
    const record = body as Record<string, unknown>
    const rawPaneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
    const stablePaneKey = this.legacyPaneKeyAliases.get(rawPaneKey)?.stablePaneKey
    if (!stablePaneKey) {
      return body
    }
    // Detached shells still post the physical key; route both pane and tab to the current owner.
    return { ...record, paneKey: stablePaneKey, tabId: parsePaneKey(stablePaneKey)?.tabId }
  }
}
