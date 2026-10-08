import { createHash } from 'node:crypto'

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
    const current = Array.from(this.currentAuthorityObservations.values())
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

  /** Records the event's launch authority and returns the event to apply: without its token when
   *  that token is the pane's ended launch's, which a later process in its shell inherited. */
  protected recordCurrentAuthorityObservation<T extends AgentHookEventPayload>(payload: T): T {
    const evidence = this.toAuthorityEvidence(payload)
    if (!evidence) {
      return payload.launchToken === undefined ? payload : { ...payload, launchToken: undefined }
    }
    this.currentAuthorityObservations.set(evidence.paneKey, evidence)
    this.persistedAuthorityCommitmentsByPaneKey.set(evidence.paneKey, evidence)
    this.hydratedLaunchTokenHashByPaneKey.set(evidence.paneKey, evidence.launchTokenHash)
    return payload
  }

  protected toAuthorityEvidence(
    payload: AgentHookEventPayload | EnrichedAgentHookEventPayload,
    launchTokenHashOverride?: string
  ): AgentHookAuthorityEvidence | null {
    const launchToken = payload.launchToken?.trim()
    const launchTokenHash =
      launchTokenHashOverride ??
      (launchToken ? createHash('sha256').update(launchToken).digest('hex') : null)
    // Why here, the one place evidence is minted: an ended launch's token, which every later process
    // in its shell inherits, is never authority again, whichever path reports it.
    if (
      !launchTokenHash ||
      launchTokenHash ===
        this.endedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(payload.paneKey))
    ) {
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
