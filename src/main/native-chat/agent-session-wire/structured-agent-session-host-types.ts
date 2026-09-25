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

/** Which provider child: the adapter acquisition and the lease fence it writes at. */
export type StructuredAgentSessionProviderChildIdentity = {
  readonly generation: string | null
  readonly fence: number
}

/** The provider process behind a conversation. Written only in
 *  `structured-agent-session-provider-child`. */
export type StructuredAgentSessionProviderChild = StructuredAgentSessionProviderChildIdentity & {
  /** A publish-first acquire is `starting` until the adapter's `started` event; only then are its
   *  reported options fact. */
  phase: StructuredAgentSessionProviderChildPhase
}

/** What ending a child established about its provider root. A stop's comes only from
 *  `stopAgentSessionProviderRoot`; an observed exit's root is gone by definition. */
export type StructuredAgentSessionStopVerdict = { rootGone: boolean }

export type StructuredAgentSessionChildEndCause =
  | 'user-stop'
  | 'host-stop'
  | 'exit'
  | 'attach-failed'
  | 'evict'

/** How the conversation's last child ended. In memory only: the delivery loop reads it to tell a
 *  Stop from a failure. */
export type StructuredAgentSessionEndedChild = StructuredAgentSessionProviderChildIdentity &
  StructuredAgentSessionStopVerdict & {
    /** `user-stop` is a Stop the user asked for; `host-stop` is the host stopping the child for a
     *  cause of its own, which fails the start the delivery loop was waiting on. */
    cause: StructuredAgentSessionChildEndCause
    /** Descriptive text only — the provider's diagnostic, or the host's cause. Decides nothing. */
    reason: string | null
    duringStartup: boolean
  }

/** The conversation: its journal, params and readers outlive any child that serves it. */
export type StructuredAgentSessionHostSession = {
  /** Readonly: a new handle enters only through the session map's `set`, which binds its delivery. */
  readonly journal: AgentSessionJournal
  params: AgentSessionAttachParams
  /** The child THIS host generation runs for the conversation. A conversation opened for reading
   *  has none — so it may not be evicted to free a child, nor have its lease released as an
   *  observed exit. */
  child: StructuredAgentSessionProviderChild | null
  /** The wind-down this host still owes for a child it started: settling that generation's work
   *  and handing the lease back. Outlives `child`, which ends the moment the adapter proves the
   *  exit — an eviction that aborts after that point must still finish it on the next close. */
  owesProviderChildWindDown?: StructuredAgentSessionProviderChildIdentity
  lastEndedChild?: StructuredAgentSessionEndedChild
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
