import { movePaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { canRegisterPaneKeyAlias, isOpaqueRemintedPaneKey } from '../../../shared/pane-key-alias'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { PANE_KEY_ALIASES_MAX } from './server-constants'
import type { EnrichedAgentHookEventPayload, PaneKeyAliasPersistenceListener } from './server-types'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import { isValidPaneKey } from './server-status-identity'
import { AgentHookServerAuthorityEvidence } from './server-authority-evidence'

export abstract class AgentHookServerAuthorityAliases extends AgentHookServerAuthorityEvidence {
  setPaneKeyAliasPersistenceListener(listener: PaneKeyAliasPersistenceListener | null): void {
    this.paneKeyAliasPersistenceListener = listener
  }

  protected getPersistedPaneKeyAliases(): LegacyPaneKeyAliasEntry[] {
    return Array.from(this.legacyPaneKeyAliases.entries()).flatMap(([legacyPaneKey, entry]) =>
      entry.ptyId
        ? [
            {
              ptyId: entry.ptyId,
              legacyPaneKey,
              stablePaneKey: entry.stablePaneKey,
              updatedAt: entry.updatedAt
            }
          ]
        : []
    )
  }

  protected notifyPaneKeyAliasPersistenceListener(): void {
    this.paneKeyAliasPersistenceListener?.(this.getPersistedPaneKeyAliases())
  }

  protected boundPaneKeyAliases(): void {
    while (this.legacyPaneKeyAliases.size > PANE_KEY_ALIASES_MAX) {
      // Why: renderer-originated aliases are untrusted; insertion-order eviction bounds memory and per-message cleanup.
      const oldestKey = this.legacyPaneKeyAliases.keys().next().value
      if (!oldestKey) {
        break
      }
      this.legacyPaneKeyAliases.delete(oldestKey)
    }
  }

  protected getPhysicalPaneKeyForAuthority(paneKey: string, ptyId?: string): string {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    let fallbackPaneKey = paneKey
    for (const [physicalPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (
        entry.stablePaneKey === ownerPaneKey &&
        (!ptyId || !entry.ptyId || entry.ptyId === ptyId)
      ) {
        if (entry.authorityVerified) {
          return physicalPaneKey
        }
        fallbackPaneKey = physicalPaneKey
      }
    }
    return fallbackPaneKey
  }

  canTransferPaneAuthority(
    fromPaneKey: string,
    ptyId: string | undefined,
    ownsPty: (physicalPaneKey: string, ptyId: string) => boolean
  ): boolean {
    if (!isValidPaneKey(fromPaneKey)) {
      return false
    }
    const ownerPaneKey = this.resolvePaneKeyAlias(fromPaneKey)
    const physicalPaneKey = this.getPhysicalPaneKeyForAuthority(fromPaneKey, ptyId)
    const alias = this.legacyPaneKeyAliases.get(physicalPaneKey)
    if (ptyId) {
      return Boolean(
        (alias?.authorityVerified && alias.ptyId === ptyId) ||
        ownsPty(physicalPaneKey, ptyId) ||
        (ownerPaneKey !== physicalPaneKey && ownsPty(ownerPaneKey, ptyId))
      )
    }
    // Why: hook status is renderer evidence, not PTY ownership; ID-less moves are safe only after a verified transfer minted an alias.
    return alias?.authorityVerified === true
  }

  registerPaneKeyAlias(
    legacyPaneKey: string,
    stablePaneKey: string,
    ptyId?: string,
    updatedAt = Date.now(),
    options?: { overwriteExisting?: boolean; authorityVerified?: boolean }
  ): void {
    const fromPaneKey = legacyPaneKey.trim()
    const toPaneKey = stablePaneKey.trim()
    if (!canRegisterPaneKeyAlias(fromPaneKey, toPaneKey)) {
      return
    }
    const existing = this.legacyPaneKeyAliases.get(fromPaneKey)
    if (existing && options?.overwriteExisting === false) {
      return
    }
    // Why: remint tokens have no embedded tab id; first pane wins so a later spawn
    // cannot steal leftover $$…:L$$ posts onto a different tab:leaf.
    if (existing && existing.stablePaneKey !== toPaneKey && isOpaqueRemintedPaneKey(fromPaneKey)) {
      return
    }
    const normalizedPtyId =
      typeof ptyId === 'string' && ptyId.trim().length > 0 ? ptyId.trim() : existing?.ptyId
    const normalizedUpdatedAt =
      Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : (existing?.updatedAt ?? Date.now())
    const authorityVerified = options?.authorityVerified ?? false
    if (
      existing &&
      existing.stablePaneKey === toPaneKey &&
      existing.ptyId === (normalizedPtyId ?? null) &&
      existing.updatedAt === normalizedUpdatedAt &&
      existing.authorityVerified === authorityVerified
    ) {
      return
    }
    this.legacyPaneKeyAliases.set(fromPaneKey, {
      stablePaneKey: toPaneKey,
      ptyId: normalizedPtyId ?? null,
      updatedAt: normalizedUpdatedAt,
      authorityVerified
    })
    this.boundPaneKeyAliases()
    if (normalizedPtyId) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
  }

  transferPaneAuthority(
    fromPaneKey: string,
    toPaneKey: string,
    ptyId?: string,
    updatedAt = Date.now(),
    options?: { authorityVerified?: boolean }
  ): void {
    if (!isValidPaneKey(fromPaneKey) || !isValidPaneKey(toPaneKey)) {
      return
    }
    const previousOwnerPaneKey = this.resolvePaneKeyAlias(fromPaneKey)
    const physicalPaneKey = this.getPhysicalPaneKeyForAuthority(fromPaneKey, ptyId)
    const existing = this.legacyPaneKeyAliases.get(physicalPaneKey)
    const normalizedPtyId = ptyId?.trim() || existing?.ptyId || null
    const hadStatus = this.state.lastStatusByPaneKey.has(previousOwnerPaneKey)
    movePaneCacheState(this.state, previousOwnerPaneKey, toPaneKey)
    const movedStatus = this.state.lastStatusByPaneKey.get(toPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (movedStatus) {
      const owner = parsePaneKey(toPaneKey)
      this.state.lastStatusByPaneKey.set(toPaneKey, {
        ...movedStatus,
        paneKey: toPaneKey,
        tabId: owner?.tabId
      })
    }
    const hydratedLaunchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(previousOwnerPaneKey)
    if (hydratedLaunchTokenHash) {
      this.hydratedLaunchTokenHashByPaneKey.delete(previousOwnerPaneKey)
      this.hydratedLaunchTokenHashByPaneKey.set(toPaneKey, hydratedLaunchTokenHash)
    }
    const persistedAuthority = this.persistedAuthorityCommitmentsByPaneKey.get(previousOwnerPaneKey)
    if (persistedAuthority) {
      const owner = parsePaneKey(toPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.delete(previousOwnerPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.set(
        toPaneKey,
        Object.freeze({
          ...persistedAuthority,
          paneKey: toPaneKey,
          ...(owner?.tabId ? { tabId: owner.tabId } : {})
        })
      )
    }
    if (this.runtimeObservedStatusPaneKeys.delete(previousOwnerPaneKey)) {
      this.runtimeObservedStatusPaneKeys.add(toPaneKey)
    }
    const restartedTokenHash =
      this.restartedStatusLaunchTokenHashByPaneKey.get(previousOwnerPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(previousOwnerPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(toPaneKey)
    if (restartedTokenHash) {
      this.restartedStatusLaunchTokenHashByPaneKey.set(toPaneKey, restartedTokenHash)
    }
    const activeTurnCompletedAt = this.activeHookTurnCompletedAtByPaneKey.get(previousOwnerPaneKey)
    if (activeTurnCompletedAt !== undefined) {
      this.activeHookTurnCompletedAtByPaneKey.delete(previousOwnerPaneKey)
      this.activeHookTurnCompletedAtByPaneKey.set(toPaneKey, activeTurnCompletedAt)
    }
    const authorityObservation = this.currentAuthorityObservations.get(previousOwnerPaneKey)
    if (authorityObservation) {
      const owner = parsePaneKey(toPaneKey)
      this.currentAuthorityObservations.delete(previousOwnerPaneKey)
      this.currentAuthorityObservations.set(
        toPaneKey,
        Object.freeze({ ...authorityObservation, paneKey: toPaneKey, tabId: owner?.tabId })
      )
    }
    const promptDedupe = this.promptSentDedupeByPaneKey.get(previousOwnerPaneKey)
    if (promptDedupe !== undefined) {
      this.promptSentDedupeByPaneKey.delete(previousOwnerPaneKey)
      this.promptSentDedupeByPaneKey.set(toPaneKey, promptDedupe)
    }
    this.clearAssistantMessageRetry(previousOwnerPaneKey)
    this.clearCodexSubagentPoll(previousOwnerPaneKey)
    // Why: the live process keeps posting the physical source key after detach; persist a chain-safe mapping to the current owner.
    this.legacyPaneKeyAliases.set(physicalPaneKey, {
      stablePaneKey: toPaneKey,
      ptyId: normalizedPtyId,
      updatedAt,
      authorityVerified: options?.authorityVerified ?? true
    })
    this.boundPaneKeyAliases()
    this.closedAgentStatusPaneKeys.delete(toPaneKey)
    this.notifyPaneKeyAliasPersistenceListener()
    if (hadStatus || persistedAuthority) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }
}
