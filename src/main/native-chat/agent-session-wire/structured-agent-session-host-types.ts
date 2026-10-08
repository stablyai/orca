import type { StructuredAgentSessionStatusObserverOptions } from './structured-agent-session-status-observation'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusSummary,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionSpawnTokenScan } from '../../runtime/agent-session-spawn-token-process-scan'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalStopSettle } from '../agent-session-journal/queued-message-pause'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionProviderChildPhase,
  StructuredAgentSessionStopCause
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-feed'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentRegistry } from './structured-agent-registry'

export type StructuredAgentSessionCaller = { callerKey: string }

/** What the host believes about a session it just made addressable again. The workspace and agent
 *  come from the record, so a caller publishes the host's view rather than a client's assertion.
 *  `readable` is false when the journal could not be opened — the tab is still worth publishing,
 *  because the chat shows that failure and its Retry. */
export type StructuredAgentSessionReveal = {
  sessionId: string
  workspaceId: string
  agent: StructuredAgentId
  readable: boolean
  /** Why the journal did not open, as a read would be refused. Host-side only: never published. */
  openRefusal?: AgentSessionWireRefusal
}

/** Which provider child: the adapter acquisition and the lease fence it writes at. */
export type StructuredAgentSessionProviderChildIdentity = {
  readonly generation: string | null
  readonly fence: number
}

/** The close a stop began for its child. It lives on the child and ends with it: once begun, the
 *  child takes no input again, and every later stop, start or provider write joins it. */
export type StructuredAgentSessionChildClose = {
  /** The first stop's, which the child's end keeps however many asks join it. */
  readonly cause: StructuredAgentSessionStopCause
  /** Asked for by quit, whose leftovers the next open settles as a crash's. */
  readonly quit?: true
  readonly reason: string | null
  /** The Stop event that stop wrote, folded before the work it ends is settled, with the settle a
   *  person's close that named no turn opens; a repeated ask reopens it. */
  recorded: Promise<JournalStopSettle | null>
  /** Where the journal stood when that stop was asked for: the child's end is ordered there, so a
   *  message accepted while the exit was being proven came after it. A repeated ask moves it. */
  requestedAt: AgentJournalCursor
}

/** The provider process behind a conversation. Written only in
 *  `structured-agent-session-provider-child`. */
export type StructuredAgentSessionProviderChild = StructuredAgentSessionProviderChildIdentity & {
  /** A publish-first acquire is `starting` until the adapter's `started` event; only then are its
   *  reported options fact. */
  phase: StructuredAgentSessionProviderChildPhase
  /** The queued message whose delivery started this child, fixed when the start is made; absent
   *  for any other start. In memory only: it tells a restart offer its own start from another. */
  readonly startedFor?: string
  close?: StructuredAgentSessionChildClose
}

/** What ending a child established about its provider root. A stop's comes only from
 *  `stopAgentSessionProviderRoot`; an observed exit's root is gone by definition. */
export type StructuredAgentSessionStopVerdict = { rootGone: boolean }

export type { StructuredAgentSessionChildEndCause }

/** How the conversation's last child ended. In memory only: the delivery loop reads it to tell a
 *  Stop from a failure. */
export type StructuredAgentSessionEndedChild = StructuredAgentSessionProviderChildIdentity &
  StructuredAgentSessionStopVerdict & {
    /** `user-stop` is a Stop the user asked for; `host-stop` is the host stopping the child for a
     *  cause of its own, which fails the start the delivery loop was waiting on. */
    cause: StructuredAgentSessionChildEndCause
    /** Descriptive text only — the provider's diagnostic, or the host's cause. Decides nothing. */
    reason: string | null
    /** What the chat records about this end; absent reads as a provider exit with no detail. */
    failure?: SubmissionRejectionFact
    duringStartup: boolean
    startedFor?: string
    /** Where the conversation's journal stood when the child ended, to order the end against a
     *  message's acceptance. A close's end stands where its stop was asked for. */
    endedAt: AgentJournalCursor
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
  lastEndedChild?: StructuredAgentSessionEndedChild
}

export type StructuredAgentSessionHostDeps = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  /** The agents this runtime drives; what each declares is read here, never from the adapter. */
  agents: StructuredAgentRegistry
  /** Optional advisory recovery storage, independent of conversation backups. */
  recoveryCapsule?: AgentSessionRecoveryCapsule
  /** The host's one chat journal database. */
  journalDatabase: JournalHostDatabase
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
  resolveLaunchEnv?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  /** Execution-host path for a newly founded floating session. */
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  now?: () => number
  /** The idle sweep's period and window. Tests drive these; production takes the defaults. */
  idleSweep?: { intervalMs?: number; idleMs?: number }
  /** Whether an orchestration dispatch still owns this session's worker; absent answers no. */
  hasOpenDispatch?: (record: AgentSessionRecord) => boolean
  /** A chat tab left the screen: closed, or its workspace removed. Advisory; a throw is logged. */
  onSessionTabHidden?: (sessionId: string) => void
  /** Where every failure the host carries on past is reported. Required: a host without one would
   *  drop exactly the failures nobody sees in the UI. */
  logger: StructuredAgentSessionLogger
  /** Every status projection this host publishes. `replay` marks a re-projection of state the host
   *  already knew (restore, an arriving subscriber) rather than a fresh journal edge. */
  onSessionStatusChanged?: (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ) => void
  /** The agent-status store every held session's projection is written to and, on close,
   *  removed from. Both production hosts pass one — the desktop and headless `orcad`; absent,
   *  every reader of that store simply lists no structured session. */
  statusSink?: StructuredAgentSessionStatusSink
  /** Host model catalog surface; absent means every catalog read answers `unknown`. */
  modelCatalog?: AgentModelCatalogService
}
