import { createHash } from 'node:crypto'

import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentHookAuthorityAttestation,
  AgentHookAuthorityEvidence,
  EnrichedAgentHookEventPayload
} from './server-types'
import { AgentHookServerStatusRetries } from './server-status-retries'
import { agentStatusSubjectKey } from '../../../shared/agent-status-subject'

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
      return hasUniqueCurrentObservation
        ? Object.freeze({
            subject: observations[0]!.subject,
            paneKey,
            source: 'current_hook' as const
          })
        : null
    }
    if (commitments.length !== 1 || this.resolvePaneKeyAlias(commitments[0]!.paneKey) !== paneKey) {
      return null
    }
    if (observations.length === 0 && paneObservations.length === 0) {
      return Object.freeze({
        subject: commitments[0]!.subject,
        paneKey,
        source: 'hydrated_commitment'
      })
    }
    if (!hasUniqueCurrentObservation) {
      return null
    }
    return Object.freeze({ subject: observations[0]!.subject, paneKey, source: 'current_hook' })
  }

  protected captureHydratedAuthorityCommitments(): void {
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    for (const [cacheKey, rawEntry] of Array.from(this.state.lastStatusByPaneKey.entries())) {
      const subject = this.statusSubjectFor(rawEntry)
      const entry = { ...rawEntry, subject } as EnrichedAgentHookEventPayload
      const statusKey = agentStatusSubjectKey(subject)
      if (cacheKey !== statusKey || rawEntry.subject === undefined) {
        this.state.lastStatusByPaneKey.delete(cacheKey)
        this.state.lastStatusByPaneKey.set(statusKey, entry)
      }
      const evidence = this.toAuthorityEvidence(
        entry,
        this.hydratedLaunchTokenHashByPaneKey.get(statusKey)
      )
      if (evidence && !this.persistedAuthorityCommitmentsByPaneKey.has(statusKey)) {
        this.persistedAuthorityCommitmentsByPaneKey.set(statusKey, evidence)
      }
    }
    this.hydratedAuthorityCommitments = Object.freeze(
      Array.from(this.persistedAuthorityCommitmentsByPaneKey.values())
    )
  }

  protected recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void {
    const evidence = this.toAuthorityEvidence(payload)
    if (evidence) {
      const statusKey = agentStatusSubjectKey(evidence.subject)
      this.currentAuthorityObservations.set(statusKey, evidence)
      this.persistedAuthorityCommitmentsByPaneKey.set(statusKey, evidence)
      this.hydratedLaunchTokenHashByPaneKey.set(statusKey, evidence.launchTokenHash)
    }
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
      subject: this.statusSubjectFor(payload),
      paneKey: payload.paneKey,
      launchTokenHash,
      connectionId: payload.connectionId,
      ...(payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
      observedAt: 'receivedAt' in payload ? payload.receivedAt : Date.now()
    })
  }
}
