import type { ProgramStatusFacet } from '../../../shared/program-status/facet'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type { PersistedAgentExitEvidence } from './agent-exit-evidence'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusState
} from '../../../shared/agent-status-types'
import type { AgentStatusObservation } from '../../../shared/agent-status-observation'
import type { AgentKind } from '../../../shared/telemetry-events'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { CodexRemoteRosterAuthority } from '../../../shared/agent-hook-listener/providers/codex-state'

/** Ingest-only fields, stripped before the row is stored. */
export type IncomingAgentHookEvent = AgentHookEventPayload & {
  authorityRestartId?: string
  codexRosterAuthority?: CodexRemoteRosterAuthority
}

export type EnrichedAgentHookEventPayload = AgentHookEventPayload & {
  /** Live acknowledgement of the matching renderer retirement; never cached. */
  authorityRestartId?: string
  receivedAt: number
  /** Persisted evidence age survives replay; absent values fall back to receivedAt, which tracks delivery order. */
  evidenceObservedAt?: number
  stateStartedAt: number
  /** Server-stamped main-agent turn start; absent until a live boundary establishes it. */
  turnStartedAt?: number
  /** Runtime provenance and ordering, including hook/OSC precedence. */
  observation?: AgentStatusObservation
  /** Hydrated work remains unconfirmed until reconciled; this marker is never persisted. */
  restoredUnconfirmed?: true
  /** User-hidden resume identity retained solely for destructive liveness checks. */
  retainedForLiveness?: true
  /** OSC 7501 facet stitched at publication, never persisted. */
  programStatus?: ProgramStatusFacet
  /** Facet-only publication; state readers must not infer a transition. */
  programStatusOnly?: true
}

// Persist non-agent work too: mainAgent cannot describe shell/cron/notification work that affects hydration.
export type PersistedAgentHookEventPayload = Omit<
  EnrichedAgentHookEventPayload,
  | 'authorityRestartId'
  | 'statusAdmissionSession'
  | 'launchToken'
  | 'hostTurnRevision'
  | 'promptInteractionKey'
  | 'programStatus'
  | 'programStatusOnly'
  | 'restoredUnconfirmed'
  // Authority IDs and revision counters belong to the runtime that issued them.
  | 'observation'
  // Terminal handles belong to one runtime.
  | 'terminalHandle'
> & {
  launchTokenHash?: string
}

export type PersistedAgentHookAuthorityCommitment = {
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}

export type AgentHookStatusChangeEntry = {
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
  paneKey: string
  sessionId: string
  transcriptPath?: string
  worktreeId?: string
}

export type AgentHookAuthorityEvidence = Readonly<{
  paneKey: string
  launchTokenHash: string
  connectionId: string | null
  tabId?: string
  worktreeId?: string
  observedAt: number
}>

export type AgentHookAuthorityAttestation = Readonly<{
  paneKey: string
  source: 'current_hook' | 'hydrated_commitment'
}>

export type StatusChangeListener = (statuses: AgentHookStatusChangeEntry[]) => void
export type StatusFreshnessListener = (status: AgentHookStatusFreshnessObservation) => void
export type ProviderSessionChangeListener = (
  providerSessions: AgentHookProviderSessionIdentity[]
) => void
export type AgentHookStatusRowIdentity = {
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
  closed?: true
  retirementIdsByPaneKey: Record<string, string>
}

export type LastStatusFile = {
  version: number
  entries: Record<string, PersistedAgentHookEventPayload>
  authorityCommitments?: Record<string, PersistedAgentHookAuthorityCommitment>
  /** Proven agent exits whose rows were reconciled away; absent from older files. */
  agentExits?: PersistedAgentExitEvidence[]
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
