import type { StructuredAgentSessionRequestFailure } from './structured-agent-session-request-failures'
import type { StructuredAgentSessionStatusObserverOptions } from './structured-agent-session-status-observation'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionNamingError,
  AgentSessionStatusSummary,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionUserNameWrite } from '../../runtime/agent-session-record-conversation-name'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionSpawnTokenScan } from '../../runtime/agent-session/ownership/agent-session-spawn-token-process-scan'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
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
import type { StructuredAgentSessionStartupLimits } from './structured-agent-session-startup-attempt-contract'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'

export type StructuredAgentSessionCaller = { callerKey: string }

/** Reveal record-authoritative identity; unreadable chats retain tabs for failure display and Retry. */
export type StructuredAgentSessionReveal = {
  sessionId: string
  workspaceId: string
  agent: StructuredAgentId
  readable: boolean
  /** Read refusal; host-only, never published. */
  openRefusal?: AgentSessionWireRefusal
}

export type StructuredAgentSessionProviderChildIdentity = {
  readonly generation: string | null
  readonly fence: number
}

/** Bound to the exact child: once closing, input stays stopped and later operations join. */
export type StructuredAgentSessionChildClose = {
  /** Retain the first Stop cause through all joined requests. */
  readonly cause: StructuredAgentSessionStopCause
  /** Quit leftovers recover as crash state on next open. */
  readonly quit?: true
  readonly reason: string | null
  readonly failure?: SubmissionRejectionFact
  /** Fold Stop before settling work; repeated unnamed personal closes reopen settlement. */
  recorded: Promise<JournalStopSettle | null>
  /** Order child exit at the Stop request; repeated requests advance this boundary. */
  requestedAt: AgentJournalCursor
}

/** Written only by structured-agent-session-provider-child. */
export type StructuredAgentSessionProviderChild = StructuredAgentSessionProviderChildIdentity & {
  /** No input or authoritative options until host open settles. */
  phase: StructuredAgentSessionProviderChildPhase
  /** Immutable, memory-only opening send ID; distinguishes its restart from another start. */
  readonly startedFor?: string
  /** Launch-time permission mode, memory-only. */
  readonly permissionMode?: AgentChatPermissionChoice
  /** Read adapter-held sends at each decision. */
  readonly heldSends?: () => ReadonlySet<string> | undefined
  readonly exitObservation?: DeferredStructuredAgentSessionEventSink['exitObservation']
  close?: StructuredAgentSessionChildClose
}

/** Root proof comes only from stopAgentSessionProviderRoot or observed exit. */
export type StructuredAgentSessionStopVerdict = { rootGone: boolean }

export type { StructuredAgentSessionChildEndCause }

/** Memory-only last-child outcome distinguishes Stop from failure in delivery. */
export type StructuredAgentSessionEndedChild = StructuredAgentSessionProviderChildIdentity &
  StructuredAgentSessionStopVerdict & {
    /** host-stop fails pending startup; user-stop is intentional. */
    cause: StructuredAgentSessionChildEndCause
    /** Diagnostic only; never used for decisions. */
    reason: string | null
    /** Defaults to provider exit without details. */
    failure?: SubmissionRejectionFact
    duringStartup: boolean
    startedFor?: string
    /** Order exit against acceptance; requested closes retain their original Stop boundary. */
    endedAt: AgentJournalCursor
  }

/** Conversation state outlives its provider children. */
export type StructuredAgentSessionHostSession = {
  /** Enter only through session-map set, which binds delivery. */
  readonly journal: AgentSessionJournal
  params: AgentSessionAttachParams
  /** Read-only conversations own no child and prove neither child exit nor lease release. */
  child: StructuredAgentSessionProviderChild | null
  lastEndedChild?: StructuredAgentSessionEndedChild
  /** Invalidates cached current work when generation ends without a row or lease write. */
  operationalRevision?: number
  /** One live restart action owns progress. */
  restartResume?: NonNullable<AgentSessionStatusSummary['restartResume']> & { operationId: string }
}

export type StructuredAgentSessionHostDeps = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  /** Capabilities come from registry declarations, never adapters. */
  agents: StructuredAgentRegistry
  /** Advisory recovery storage, independent of conversation backups. */
  recoveryCapsule?: AgentSessionRecoveryCapsule
  journalDatabase: JournalHostDatabase
  claimKeyId: string
  probeOwner?: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeOwners?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  /** Request recovery exit only; lease release needs a later proven-absent probe. */
  stopOwnerProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** null means process enumeration is unsupported, never empty. */
  scanSpawnTokenProcesses?: () => Promise<AgentSessionSpawnTokenScan | null>
  mintSpawnToken?: () => string
  resolveLaunchArgs?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<string[] | undefined> | string[] | undefined
  resolveLaunchEnv?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  /** Execution-host path for a new floating session. */
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  now?: () => number
  idleSweep?: { intervalMs?: number; idleMs?: number }
  startupLimits?: Partial<StructuredAgentSessionStartupLimits>
  /** Absent means no dispatch ownership. */
  hasOpenDispatch?: (record: AgentSessionRecord) => boolean
  /** Advisory tab-hidden notice; failures are logged. */
  onSessionTabHidden?: (sessionId: string) => void
  /** Throws while a terminal may still write the record's head conversation; run before a spawn. */
  assertNoTerminalWriter?: (record: AgentSessionRecord) => Promise<void>
  /** Where every failure the host carries on past is reported. Required: a host without one would
   *  drop exactly the failures nobody sees in the UI. */
  logger: StructuredAgentSessionLogger
  onRequestFailure?: (failure: StructuredAgentSessionRequestFailure) => void
  /** replay distinguishes restored/projected state from fresh journal events. */
  onSessionStatusChanged?: (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ) => void
  /** Publishes held sessions; absent means no structured sessions in status-store readers. */
  statusSink?: StructuredAgentSessionStatusSink
  /** Absent catalog reads return unknown. */
  modelCatalog?: AgentModelCatalogService
  conversationNaming?: StructuredAgentSessionConversationNaming
}

export type SetUserConversationName = StructuredAgentSessionConversationNaming['setUserName']

/** Published only while the chat is still named forName. */
export type StructuredChatNamingFailure = AgentSessionNamingError & { forName: string }

export type StructuredAgentSessionConversationNaming = {
  activeSessionIds: () => string[]
  failure: (sessionId: string) => StructuredChatNamingFailure | undefined
  /** Full failed naming output; local-only, never published. */
  failureOutput: (sessionId: string) => string | null
  /** Start or join naming; false if the host has no such chat. */
  regenerate: (sessionId: string) => boolean
  /** Saves the user's name for the chat; null when the host has no such chat. `name` is what the
   *  chat is called afterwards, which differs from the request when a legacy alias was refused. */
  setUserName: (
    sessionId: string,
    name: string,
    write: AgentSessionUserNameWrite
  ) => Promise<{ name: string | null; applied: boolean } | null>
}
