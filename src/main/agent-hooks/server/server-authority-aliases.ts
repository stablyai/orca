import { movePaneCacheState } from '../../../shared/agent-hook-listener/listener-state'
import { canRegisterPaneKeyAlias, isOpaqueRemintedPaneKey } from '../../../shared/pane-key-alias'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { PANE_KEY_ALIASES_MAX } from './server-constants'
import type { EnrichedAgentHookEventPayload, PaneKeyAliasPersistenceListener } from './server-types'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import { isValidPaneKey } from './server-status-identity'
import { AgentHookServerAuthorityEvidence } from './server-authority-evidence'
import {
  agentStatusSubjectKey,
  makePtyAgentStatusSubject,
  parseAgentStatusSubjectKey
} from '../../../shared/agent-status-subject'

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
    options?: { authorityVerified?: boolean; emitStatusRowMutation?: boolean }
  ): void {
    if (!isValidPaneKey(fromPaneKey) || !isValidPaneKey(toPaneKey)) {
      return
    }
    const previousOwnerPaneKey = this.resolvePaneKeyAlias(fromPaneKey)
    const physicalPaneKey = this.getPhysicalPaneKeyForAuthority(fromPaneKey, ptyId)
    const existing = this.legacyPaneKeyAliases.get(physicalPaneKey)
    const normalizedPtyId = ptyId?.trim() || existing?.ptyId || null
    const owner = parsePaneKey(toPaneKey)
    const previousStatuses = this.statusEntriesForPaneKey(previousOwnerPaneKey).filter(
      (status) => status.subject.kind === 'pty'
    )
    const statusKeys = this.statusKeysForPaneKeys(new Set([previousOwnerPaneKey]))
    const transferredStatuses: {
      previous: EnrichedAgentHookEventPayload
      transferred: EnrichedAgentHookEventPayload
    }[] = []
    const hadPersistedAuthority = Array.from(
      this.persistedAuthorityCommitmentsByPaneKey.values()
    ).some((evidence) => evidence.paneKey === previousOwnerPaneKey)
    // A cache may have been populated before typed subjects were introduced.
    movePaneCacheState(this.state, previousOwnerPaneKey, toPaneKey)
    for (const oldStatusKey of statusKeys) {
      const oldSubject = parseAgentStatusSubjectKey(oldStatusKey)
      if (oldSubject?.kind !== 'pty' || oldSubject.paneKey !== previousOwnerPaneKey) {
        continue
      }
      const { kind: _kind, paneKey: _paneKey, ...scope } = oldSubject
      const subject = makePtyAgentStatusSubject(scope, toPaneKey)
      const newStatusKey = agentStatusSubjectKey(subject)
      const previousStatus = this.state.lastStatusByPaneKey.get(oldStatusKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      movePaneCacheState(this.state, oldStatusKey, newStatusKey)
      if (previousStatus) {
        const transferred = {
          ...previousStatus,
          subject,
          paneKey: toPaneKey,
          tabId: owner?.tabId
        }
        this.state.lastStatusByPaneKey.set(newStatusKey, transferred)
        transferredStatuses.push({ previous: previousStatus, transferred })
      }
      const hydratedLaunchTokenHash = this.hydratedLaunchTokenHashByPaneKey.get(oldStatusKey)
      if (hydratedLaunchTokenHash) {
        this.hydratedLaunchTokenHashByPaneKey.delete(oldStatusKey)
        this.hydratedLaunchTokenHashByPaneKey.set(newStatusKey, hydratedLaunchTokenHash)
      }
      const persistedAuthority = this.persistedAuthorityCommitmentsByPaneKey.get(oldStatusKey)
      if (persistedAuthority) {
        this.persistedAuthorityCommitmentsByPaneKey.delete(oldStatusKey)
        this.persistedAuthorityCommitmentsByPaneKey.set(
          newStatusKey,
          Object.freeze({
            ...persistedAuthority,
            subject,
            paneKey: toPaneKey,
            ...(owner?.tabId ? { tabId: owner.tabId } : {})
          })
        )
      }
      if (this.runtimeObservedStatusPaneKeys.delete(oldStatusKey)) {
        this.runtimeObservedStatusPaneKeys.add(newStatusKey)
      }
      const activeTurnCompletedAt = this.activeHookTurnCompletedAtByPaneKey.get(oldStatusKey)
      if (activeTurnCompletedAt !== undefined) {
        this.activeHookTurnCompletedAtByPaneKey.delete(oldStatusKey)
        this.activeHookTurnCompletedAtByPaneKey.set(newStatusKey, activeTurnCompletedAt)
      }
      const evidenceObservedAt = this.evidenceObservedAtByPaneKey.get(oldStatusKey)
      if (evidenceObservedAt !== undefined) {
        this.evidenceObservedAtByPaneKey.delete(oldStatusKey)
        this.evidenceObservedAtByPaneKey.set(newStatusKey, evidenceObservedAt)
      }
      const authorityObservation = this.currentAuthorityObservations.get(oldStatusKey)
      if (authorityObservation) {
        this.currentAuthorityObservations.delete(oldStatusKey)
        this.currentAuthorityObservations.set(
          newStatusKey,
          Object.freeze({
            ...authorityObservation,
            subject,
            paneKey: toPaneKey,
            ...(owner?.tabId ? { tabId: owner.tabId } : {})
          })
        )
      }
      const promptDedupe = this.promptSentDedupeByPaneKey.get(oldStatusKey)
      if (promptDedupe !== undefined) {
        this.promptSentDedupeByPaneKey.delete(oldStatusKey)
        this.promptSentDedupeByPaneKey.set(newStatusKey, promptDedupe)
      }
      this.clearAssistantMessageRetry(oldStatusKey)
      this.clearCodexSubagentPoll(oldStatusKey)
      this.observations.forget(oldStatusKey)
    }
    const restartedTokenHash =
      this.restartedStatusLaunchTokenHashByPaneKey.get(previousOwnerPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(previousOwnerPaneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(toPaneKey)
    if (restartedTokenHash) {
      this.restartedStatusLaunchTokenHashByPaneKey.set(toPaneKey, restartedTokenHash)
    }
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
    for (const { previous, transferred } of transferredStatuses) {
      this.commitStatusRowMutation(previous, transferred, options?.emitStatusRowMutation !== false)
    }
    if (previousStatuses.length > 0 || hadPersistedAuthority) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }
}
