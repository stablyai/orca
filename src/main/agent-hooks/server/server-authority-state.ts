import type { AgentStatusParentRecord } from '../../../shared/agent-status-store-parent'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookAuthorityEvidence } from './server-types'
import { RevisionedMap } from './revisioned-map'

export type AgentHookLaunchSubject = AgentHookEventPayload | AgentStatusParentRecord

export type AgentHookLaunchObservation = {
  evidence: AgentHookAuthorityEvidence
  row: AgentHookEventPayload
  subject: AgentHookLaunchSubject
  launchToken?: string
  isCurrent?: () => boolean
  executionIsCurrent?: () => boolean
}

/** Launch credentials are admitted independently of the latest status row. */
export abstract class AgentHookServerAuthorityState {
  protected abstract recordCurrentAuthorityObservation(
    payload: AgentHookEventPayload,
    row?: AgentHookEventPayload,
    isCurrent?: () => boolean,
    derivedFrom?: AgentHookEventPayload,
    subject?: AgentHookLaunchSubject
  ): boolean
  protected abstract captureTmuxRoot(paneKey: string): (() => boolean) | undefined
  protected abstract captureHydratedAuthorityCommitments(): void
  protected abstract scheduleStatusPersist(): void
  protected abstract resolvePaneKeyAlias(paneKey: string): string

  protected hydratedAuthorityCommitments: readonly AgentHookAuthorityEvidence[] = Object.freeze([])
  // Why: revisioned so a persisted-authority change can bypass the write throttle (spool replay and
  // restored-terminal attestation read these after a crash).
  protected hydratedLaunchTokenHashByPaneKey = new RevisionedMap<string, string>()
  protected persistedAuthorityCommitmentsByPaneKey = new RevisionedMap<
    string,
    AgentHookAuthorityEvidence
  >()
  protected revokedHydratedAuthorityCommitments = new WeakSet<AgentHookAuthorityEvidence>()
  protected currentAuthorityObservations = new Map<string, AgentHookLaunchObservation>()
  protected pendingLaunchAuthority = new Map<string, AgentHookLaunchObservation>()
  protected launchAuthorityVerifier:
    | ((
        candidate: AgentHookAuthorityEvidence,
        terminalHandle?: string
      ) => boolean | (() => boolean))
    | null = null
  protected unsubscribeLaunchAuthority: (() => void) | null = null
}
