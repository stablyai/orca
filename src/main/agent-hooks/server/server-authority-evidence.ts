import { createHash } from 'node:crypto'
import { isSameAgentProcess } from '../../../shared/agent-process-presence'
import type { AgentHookLaunchObservation, AgentHookLaunchSubject } from './server-authority-state'

import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentHookAuthorityAttestation,
  AgentHookAuthorityEvidence,
  EnrichedAgentHookEventPayload
} from './server-types'
import { AgentHookServerStatusRetries } from './server-status-retries'

export abstract class AgentHookServerAuthorityEvidence extends AgentHookServerStatusRetries {
  attestCompatibilityAuthority(candidate: {
    paneKey: string
    launchTokenHash: string
    connectionId: string | null
    terminalProvenance: 'current_runtime' | 'restored'
  }): AgentHookAuthorityAttestation | null {
    const paneKey = this.resolvePaneKeyAlias(candidate.paneKey)
    const matchesCandidate = (entry: AgentHookAuthorityEvidence): boolean =>
      entry.launchTokenHash === candidate.launchTokenHash &&
      entry.connectionId === candidate.connectionId
    const commitments = this.hydratedAuthorityCommitments.filter(
      (entry) => matchesCandidate(entry) && !this.revokedHydratedAuthorityCommitments.has(entry)
    )
    const current = Array.from(
      this.currentAuthorityObservations.values(),
      (entry) => entry.evidence
    )
    const observations = current.filter(matchesCandidate)
    const paneObservations = current.filter(
      (entry) => this.resolvePaneKeyAlias(entry.paneKey) === paneKey
    )
    const hasUniqueCurrentObservation =
      observations.length === 1 &&
      paneObservations.length === 1 &&
      this.resolvePaneKeyAlias(observations[0]!.paneKey) === paneKey
    if (candidate.terminalProvenance === 'current_runtime') {
      return hasUniqueCurrentObservation ? Object.freeze({ paneKey, source: 'current_hook' }) : null
    }
    if (commitments.length !== 1 || this.resolvePaneKeyAlias(commitments[0]!.paneKey) !== paneKey) {
      return null
    }
    if (observations.length === 0 && paneObservations.length === 0) {
      return Object.freeze({ paneKey, source: 'hydrated_commitment' })
    }
    if (!hasUniqueCurrentObservation) {
      return null
    }
    return Object.freeze({ paneKey, source: 'current_hook' })
  }

  protected captureHydratedAuthorityCommitments(): void {
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    for (const entry of this.state.lastStatusByPaneKey.values()) {
      const evidence = this.toAuthorityEvidence(
        entry as EnrichedAgentHookEventPayload,
        this.hydratedLaunchTokenHashByPaneKey.get(entry.paneKey)
      )
      if (evidence && !this.persistedAuthorityCommitmentsByPaneKey.has(entry.paneKey)) {
        this.persistedAuthorityCommitmentsByPaneKey.set(entry.paneKey, evidence)
      }
    }
    this.hydratedAuthorityCommitments = Object.freeze(
      Array.from(this.persistedAuthorityCommitmentsByPaneKey.values())
    )
  }

  setLaunchAuthorityVerifier(
    verify: NonNullable<typeof this.launchAuthorityVerifier>,
    subscribe: (listener: (paneKey: string) => void) => () => void
  ): void {
    this.unsubscribeLaunchAuthority?.()
    this.launchAuthorityVerifier = verify
    const resolve = (paneKey: string): void => this.resolvePendingLaunchAuthority(paneKey)
    this.unsubscribeLaunchAuthority = subscribe(resolve)
    for (const paneKey of this.pendingLaunchAuthority.keys()) {
      resolve(paneKey)
    }
  }

  protected resolvePendingLaunchAuthority(paneKey: string): void {
    const owner = this.resolvePaneKeyAlias(paneKey)
    const pending = this.pendingLaunchAuthority.get(owner)
    if (!pending) {
      return
    }
    if (!this.applicableAuthority(pending) || this.closedAgentStatusPaneKeys.has(owner)) {
      this.pendingLaunchAuthority.delete(owner)
      return
    }
    if (this.admitLaunchAuthority(pending)) {
      this.publishAuthorityCorrelation(owner)
    }
  }

  private admitLaunchAuthority(observation: AgentHookLaunchObservation): boolean {
    const { evidence, row } = observation
    const retained = this.hydratedAuthorityCommitments.filter(
      (entry) =>
        !this.revokedHydratedAuthorityCommitments.has(entry) &&
        entry.launchTokenHash === evidence.launchTokenHash &&
        entry.connectionId === evidence.connectionId
    )
    const eligible =
      retained.length === 1 && this.resolvePaneKeyAlias(retained[0]!.paneKey) === evidence.paneKey
    const verified = this.launchAuthorityVerifier?.(evidence, row.terminalHandle)
    if (!eligible && !verified) {
      return false
    }
    observation.executionIsCurrent = eligible
      ? () => !this.revokedHydratedAuthorityCommitments.has(retained[0]!)
      : typeof verified === 'function'
        ? verified
        : undefined
    this.currentAuthorityObservations.set(evidence.paneKey, observation)
    this.persistedAuthorityCommitmentsByPaneKey.set(evidence.paneKey, evidence)
    this.hydratedLaunchTokenHashByPaneKey.set(evidence.paneKey, evidence.launchTokenHash)
    this.pendingLaunchAuthority.delete(evidence.paneKey)
    this.scheduleStatusPersist()
    return true
  }

  protected recordCurrentAuthorityObservation(
    payload: AgentHookEventPayload,
    row = payload,
    isCurrent?: () => boolean,
    derivedFrom?: AgentHookEventPayload,
    subject: AgentHookLaunchSubject = row
  ): boolean {
    const evidence = this.toAuthorityEvidence(payload)
    if (evidence) {
      const observation = { evidence, row, subject, launchToken: payload.launchToken, isCurrent }
      if (this.admitLaunchAuthority(observation)) {
        return true
      }
      this.pendingLaunchAuthority.set(payload.paneKey, observation)
    } else {
      // Only a known derivation can carry correlation when optional execution identity is absent.
      for (const map of [this.pendingLaunchAuthority, this.currentAuthorityObservations]) {
        const previous = map.get(payload.paneKey)
        if (
          derivedFrom &&
          previous?.subject === derivedFrom &&
          this.sameTerminalOwner(derivedFrom, row) &&
          derivedFrom.payload.agentType === row.payload.agentType &&
          derivedFrom.providerSession?.id === row.providerSession?.id &&
          derivedFrom.providerSession?.key === row.providerSession?.key &&
          (!derivedFrom.agentPresence?.process ||
            (row.agentPresence?.process &&
              isSameAgentProcess(derivedFrom.agentPresence.process, row.agentPresence.process)))
        ) {
          map.set(payload.paneKey, { ...previous, row, subject, isCurrent })
        } else if (map === this.pendingLaunchAuthority) {
          map.delete(payload.paneKey)
        }
      }
    }
    return false
  }

  protected revokeHydratedAuthorityForPaneKeys(
    paneKeys: ReadonlySet<string>,
    hash?: string
  ): boolean {
    let changed = false
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (
        (!hash || commitment.launchTokenHash === hash) &&
        (paneKeys.has(commitment.paneKey) ||
          paneKeys.has(this.resolvePaneKeyAlias(commitment.paneKey)))
      ) {
        this.revokedHydratedAuthorityCommitments.add(commitment)
        changed = true
      }
    }
    for (const paneKey of paneKeys) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      for (const key of new Set([paneKey, resolvedPaneKey])) {
        if (!hash || this.hydratedLaunchTokenHashByPaneKey.get(key) === hash) {
          changed = this.hydratedLaunchTokenHashByPaneKey.delete(key) || changed
        }
        if (
          !hash ||
          this.persistedAuthorityCommitmentsByPaneKey.get(key)?.launchTokenHash === hash
        ) {
          changed = this.persistedAuthorityCommitmentsByPaneKey.delete(key) || changed
        }
      }
    }
    return changed
  }

  protected toAuthorityEvidence(
    payload: AgentHookEventPayload | EnrichedAgentHookEventPayload,
    launchTokenHashOverride?: string
  ): AgentHookAuthorityEvidence | null {
    const launchToken = payload.launchToken?.trim()
    const launchTokenHash =
      launchTokenHashOverride ??
      (launchToken ? createHash('sha256').update(launchToken).digest('hex') : null)
    if (!launchTokenHash) {
      return null
    }
    return Object.freeze({
      paneKey: payload.paneKey,
      launchTokenHash,
      connectionId: payload.connectionId,
      ...(payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
      observedAt: 'receivedAt' in payload ? payload.receivedAt : Date.now()
    })
  }
}
