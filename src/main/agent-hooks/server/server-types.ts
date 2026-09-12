import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusState
} from '../../../shared/agent-status-types'
import type { AgentStatusObservation } from '../../../shared/agent-status-observation'
import type { AgentKind } from '../../../shared/telemetry-events'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { AgentStatusSubject } from '../../../shared/agent-status-subject'

// Why: server-side enrichment — receivedAt = latest event arrival, stateStartedAt = when the current state first appeared; extra fields ride the shared map untouched (it only writes/clears).
export type EnrichedAgentHookEventPayload = Omit<AgentHookEventPayload, 'subject'> & {
  subject: AgentStatusSubject
  receivedAt: number
  /** When this evidence was first observed, as distinct from `receivedAt`. A relay reconnect
   *  replays cached rows and `receivedAt` must restamp to clear the connection watermark, so
   *  only this clock can answer how old the evidence itself is. Persisted so it survives a
   *  main restart; absent means "never separately observed" and consumers use `receivedAt`. */
  evidenceObservedAt?: number
  stateStartedAt: number
  /** Provenance/ordering stamped by this server as the pane authority (STA-4293). Read by nothing yet. */
  observation?: AgentStatusObservation
  /** Stamped at hydrate for nonterminal states; never persisted (hydrate re-stamps) and cleared by any accepted live event replacing the entry. */
  restoredUnconfirmed?: true
  /** User-hidden resume identity retained solely for destructive liveness checks. */
  retainedForLiveness?: true
  /** Persisted proof that a lead boundary was held working only by child agents. */
  claudeLeadBoundaryChildOnly?: true
}

export type PersistedAgentHookEventPayload = Omit<
  EnrichedAgentHookEventPayload,
  | 'claudeRunningNonAgentTask'
  | 'launchToken'
  | 'promptInteractionKey'
  | 'restoredUnconfirmed'
  // Why: revision counters are in-memory and the authority id is regenerated per process, so
  // a stored observation could only rehydrate as a stale ordering claim from a dead authority.
  | 'observation'
  // Same: a terminal handle is issued by one runtime and means nothing to the next.
  | 'terminalHandle'
> & {
  launchTokenHash?: string
}

export type PersistedAgentHookAuthorityCommitment = {
  subject: AgentStatusSubject
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}

export type AgentHookStatusChangeEntry = {
  subject: AgentStatusSubject
  paneKey: string
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

export type AgentHookStatusFreshnessObservation = AgentHookStatusChangeEntry & {
  worktreeId?: string
  terminalHandle?: string
}

export type AgentHookProviderSessionIdentity = {
  subject: AgentStatusSubject
  paneKey: string
  sessionId: string
  transcriptPath?: string
  worktreeId?: string
}

export type AgentHookAuthorityEvidence = Readonly<{
  subject: AgentStatusSubject
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}>

export type AgentHookAuthorityAttestation = Readonly<{
  /** Present on attestations minted by the canonical store; optional at the compatibility edge. */
  subject?: AgentStatusSubject
  paneKey: string
  source: 'current_hook' | 'hydrated_commitment'
}>

export type StatusChangeListener = (statuses: AgentHookStatusChangeEntry[]) => void
export type StatusFreshnessListener = (status: AgentHookStatusFreshnessObservation) => void
export type ProviderSessionChangeListener = (
  providerSessions: AgentHookProviderSessionIdentity[]
) => void
export type AgentHookStatusRowIdentity = {
  subject: AgentStatusSubject
  paneKey: string
  worktreeId?: string
  terminalHandle?: string
}
export type AgentHookStatusRowMutation = {
  before: AgentHookStatusRowIdentity | null
  after: AgentHookStatusRowIdentity | null
}
export type StatusRowMutationListener = (mutation: AgentHookStatusRowMutation) => void
export type PaneStatusClearListener = (clear: AgentStatusClearIpcPayload) => void
export type StatusDropListener = (paneKey: string) => void
export type PaneKeyAliasPersistenceListener = (entries: LegacyPaneKeyAliasEntry[]) => void

export type PaneKeyAliasEntry = {
  stablePaneKey: string
  ptyId: string | null
  updatedAt: number
  authorityVerified: boolean
}
export type RetiredPaneAlias = { physicalPaneKey: string; entry: PaneKeyAliasEntry }
/** What one retirement fenced, so a re-attach can lift exactly that set and no more. */
export type RetiredPaneFence = {
  paneKeys: readonly string[]
  aliases: readonly RetiredPaneAlias[]
}

export type LastStatusFile = {
  version: number
  entries: Record<string, PersistedAgentHookEventPayload>
  /** Lossless scoped rows; `entries` remains the pane-key rollback shadow for older builds. */
  subjectEntries?: PersistedAgentHookEventPayload[]
  authorityCommitments?: Record<string, PersistedAgentHookAuthorityCommitment>
  subjectAuthorityCommitments?: PersistedAgentHookAuthorityCommitment[]
}

export type AgentPromptSentDedupeEntry = {
  agentKind: AgentKind
  promptHash: string
  promptInteractionKey?: string
}

export type NormalizedLocalHook = {
  event: AgentHookEventPayload | null
  onAccepted?: () => void
}

export type ServerStatusLineListener = ((event: ClaudeStatusLineRateLimits) => void) | null
export type ServerAgentStatusListener = ((payload: EnrichedAgentHookEventPayload) => void) | null
