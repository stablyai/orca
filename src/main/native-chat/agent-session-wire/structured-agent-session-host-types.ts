import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionSpawnTokenScan } from '../../runtime/agent-session-spawn-token-process-scan'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-feed'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'

export type StructuredAgentSessionCaller = { callerKey: string }

/** What the host believes about a session it just made addressable again. The workspace and agent
 *  come from the record, so a caller publishes the host's view rather than a client's assertion.
 *  `readable` is false when the journal could not be opened — the tab is still worth publishing,
 *  because attach recovers what read restore cannot. */
export type StructuredAgentSessionReveal = {
  sessionId: string
  workspaceId: string
  agent: 'claude' | 'codex'
  readable: boolean
}

export type StructuredAgentSessionHostSession = {
  /** Readonly: a new handle enters only through the session map's `set`, which binds its delivery. */
  readonly journal: AgentSessionJournal
  params: AgentSessionAttachParams
  fence: number
  /** Whether THIS host generation is running the provider process behind the session. A journal
   *  restored for reading has none — so it may not be evicted to free a child, nor have its lease
   *  released as an observed exit. */
  hasProviderChild: boolean
  /** Whether the child behind `hasProviderChild` has proven its start. A publish-first acquire
   *  is `starting` until the adapter's `started` event; only then are its reported options fact. */
  providerChildPhase: StructuredAgentSessionProviderChildPhase
  /** The wind-down this host still owes for a child it started: settling that generation's work
   *  and handing the lease back. A separate fact from `hasProviderChild`, which goes false the
   *  moment the adapter proves the exit — an eviction that aborts after that point must still be
   *  able to finish the wind-down on the next close. */
  owesProviderChildWindDown?: boolean
  /** Exact adapter acquisition behind `hasProviderChild`; retained after exit to fence recovery. */
  acquisitionGeneration: string | null
}

export type StructuredAgentSessionHostDeps = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  /** Optional advisory recovery storage, independent of conversation backups. */
  recoveryCapsule?: AgentSessionRecoveryCapsule
  journalRoot: string
  claimKeyId: string
  probeOwner?: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeOwners?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  /** Recovery-exit stop requests only; a lease moves only on a later proven-absent probe. */
  stopOwnerProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Host spawn-token process scan; null means the platform cannot enumerate, never "none". */
  scanSpawnTokenProcesses?: () => Promise<AgentSessionSpawnTokenScan | null>
  mintSpawnToken?: () => string
  resolveLaunchArgs?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<string[] | undefined> | string[] | undefined
  resolveLaunchEnv?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  now?: () => number
  /** How long a session outlives its last surface. Tests drive this; production takes the default. */
  releaseGraceMs?: number
  onEventSinkError?: (input: { sessionId: string; error: unknown }) => void
  /** Every status projection this host publishes. `replay` marks a re-projection of state the host
   *  already knew (restore, an arriving subscriber) rather than a fresh journal edge. */
  onSessionStatusChanged?: (
    summary: AgentSessionStatusSummary,
    options: { replay: boolean }
  ) => void
  /** The agent-status store every held session's projection is written to and, on close,
   *  removed from. Both production hosts pass one — the desktop and headless `orcad`; absent,
   *  every reader of that store simply lists no structured session. */
  statusSink?: StructuredAgentSessionStatusSink
  /** Host model catalog surface; absent means every catalog read answers `unknown`. */
  modelCatalog?: AgentModelCatalogService
}
