import { clearPaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { AgentHookServerAuthorityAliases } from './server-authority-aliases'
import type { RetiredPaneAlias, RetiredPaneFence } from './server-types'

export abstract class AgentHookServerAuthorityFences extends AgentHookServerAuthorityAliases {
  // Why: retirement fences a pane and every alias of it, then deletes those aliases.
  retirePaneAuthority(paneKey: string): void {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneKeys = new Set([paneKey, ownerPaneKey])
    const retiredAliases: RetiredPaneAlias[] = []
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
    this.recordRetiredPaneFence(paneKeys, retiredAliases)
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    const hadStatus = [...paneKeys].some((key) => this.state.lastStatusByPaneKey.has(key))
    for (const key of paneKeys) {
      this.markPaneClosedForAgentStatus(key)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(key)
      this.clearAssistantMessageRetry(key)
      this.clearCodexSubagentPoll(key)
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
    if (hadStatus || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  // Why: retirement fences a pane and every alias of it, then deletes those aliases.
  // Lifting only the key we are handed strands the rest — a detached pane's process
  // keeps posting the key it launched under, so it would stay suppressed forever with
  // the fence apparently lifted. Replay the recorded fence instead: same key set, same
  // aliases. Keys and aliases belonging to a closed tab are skipped, so the stronger
  // claim survives and a live process is never routed back into a closed tab.
  protected restoreRetiredPaneFence(fence: RetiredPaneFence): void {
    let aliasChanged = false
    for (const { physicalPaneKey, entry } of fence.aliases) {
      if (
        this.isClosedAgentStatusTabForPaneKey(physicalPaneKey) ||
        this.isClosedAgentStatusTabForPaneKey(entry.stablePaneKey) ||
        // Why: the pane was rebound in the meantime; the newer alias is the truth.
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
    // Why: retirement is a claim that a pane is gone. Re-attaching a live PTY to that
    // exact pane disproves the claim at the moment it stops being true, so the fence
    // lifts here instead of waiting for the agent to speak again — an agent re-attached
    // mid-turn or left idle would otherwise stay suppressed for the rest of its life
    // (STA-4114). A closed *tab* is a separate, stronger claim and is left standing.
    const fence =
      this.retiredPaneFencesByKey.get(paneKey) ?? this.retiredPaneFencesByKey.get(ownerPaneKey)
    let restored = false
    for (const key of new Set([paneKey, ownerPaneKey, ...(fence?.paneKeys ?? [])])) {
      if (this.isClosedAgentStatusTabForPaneKey(key)) {
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

  clearPaneKeyAliasesForPty(
    ptyId: string,
    options?: { shouldClearStablePaneKey?: (paneKey: string) => boolean }
  ): void {
    let aliasChanged = false
    let statusChanged = false
    const clearedStatusPaneKeys = new Set<string>()
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
      }
      if (shouldClearStablePaneKey) {
        // Why: hydrated rows live under the stable key; if this PTY dies before ptyPaneKey rebuilds, alias cleanup is the only evictor.
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
    // Why: detached shells keep posting the immutable physical pane key; normalize pane and tab identity to the current owner.
    return { ...record, paneKey: stablePaneKey, tabId: parsePaneKey(stablePaneKey)?.tabId }
  }
}
