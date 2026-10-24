import type { AiVaultConversationCopy } from '../../../shared/ai-vault-resume-preparation'
import type { AgentSessionAccountKind } from '../../../shared/agent-session-availability'
import type {
  AgentSessionRewindFork,
  AgentSessionRewindReason,
  AgentSessionRewindSupport
} from '../../../shared/agent-session-rewind'
// The host owns journal/lease authority; adapters report delivery uncertainty without guessing.

import type {
  AgentChildWorkStopAcknowledgement,
  AgentSessionBackgroundTaskStops
} from '../../../shared/agent-child-work-stop-targets'
import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalTurnItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'
import type { AgentSessionThreadGoalChange } from '../../../shared/agent-session-thread-goal-wire'
import type { AgentSessionRefusalReason } from '../../../shared/agent-session-wire-refusals'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionAdapterStop } from './structured-agent-session-adapter-stop'
export type { AgentSessionCancelOutcome } from './structured-agent-session-adapter-stop'
export type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionStopCause
} from './structured-agent-session-stop-cause'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type {
  StructuredAgentSessionStartupAttempt,
  StructuredAgentSessionAcquisitionReceipt
} from './structured-agent-session-startup-attempt-contract'
import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'
import type {
  StructuredAgentSessionProviderOpen,
  StructuredAgentSessionProviderOpenResult
} from './structured-agent-session-provider-open-contract'

import type {
  StructuredAgentSessionLiveOptions,
  StructuredAgentSessionOptionProjection
} from './structured-agent-session-option-models'
export type { StructuredAgentSessionLiveOptions } from './structured-agent-session-option-models'

export class AgentSessionAcquisitionRefusal extends Error {
  readonly code = 'agent_session_operation_invalid'

  constructor(
    message: string,
    /** UI refusal reason; message stays in logs. Defaults to providerStartFailed. */
    readonly reason: AgentSessionRefusalReason<'agent_session_operation_invalid'> = 'providerStartFailed',
    readonly account?: AgentSessionAccountKind
  ) {
    super(message)
    this.name = 'AgentSessionAcquisitionRefusal'
  }

  static historyTooLarge(message: string): AgentSessionAcquisitionRefusal {
    return new AgentSessionAcquisitionRefusal(message, 'historyTooLarge')
  }
}

export class AgentSessionPromptUnavailableError extends Error {
  constructor(itemId: string) {
    super(`The provider is no longer waiting on ${itemId}.`)
    this.name = 'AgentSessionPromptUnavailableError'
  }
}

/** Reject before journal commit when a provider reply cannot be constructed. */
export class AgentSessionPromptAnswerRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionPromptAnswerRejectedError'
  }
}

export {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from './structured-agent-session-acquisition-errors'

export type AgentSessionAcquisition = {
  process: AgentSessionProcessIdentity
  /** Spawn-time handles only; protocol handles come from open. */
  link?: AgentSessionProviderHandleLink
  /** Exact host-local child identity, even when acquisitions reuse a durable fence. */
  acquisitionGeneration: string
}

export type AgentSessionPreSpawnReason = Extract<
  AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  | 'managedAccountEnvOverride'
  | 'accountSwitchInProgress'
  | 'managedAccountUnsupported'
  | 'launchFolderMissing'
  | 'historyInOtherAccount'
  | 'claudeAccountFolderMissing'
  | 'claudeAccountSetupFailed'
  | 'agentCommandNotRunnable'
  | 'runtimeNotInstalled'
>

/** First-hand proof that acquisition spawned no process. */
export class AgentSessionPreSpawnError extends Error {
  /** Absent reasons are log-only; wrapped pre-spawn errors retain theirs. */
  readonly reason: AgentSessionPreSpawnReason | undefined

  constructor(
    cause: unknown,
    options: { reason?: AgentSessionPreSpawnReason; message?: string } = {}
  ) {
    super(options.message ?? (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'AgentSessionPreSpawnError'
    this.reason = options.reason ?? (isAgentSessionPreSpawnError(cause) ? cause.reason : undefined)
  }
}

export function isAgentSessionPreSpawnError(error: unknown): error is AgentSessionPreSpawnError {
  return error instanceof Error && error.name === 'AgentSessionPreSpawnError'
}

/** The host creates the command’s running turn; the child translator ends it and writes its result. */
export type StructuredAgentSessionCommandRun = {
  clientMessageId: string
  turnId: string
  identity: AgentJournalItemIdentity
  resultIdentity: AgentJournalItemIdentity
  running: AgentJournalTurnItem
}

/** Commands may answer in place without echoing provider items. */
export type AgentSessionCommandAdmission =
  | AgentSessionDispatchOutcome
  | { state: 'accepted'; providerIdentity: null }

/** Execution evidence only, never picker defaults; steers report their running turn’s choices. */
export type AgentSessionRanOptionsEvidence = { ranOptions?: Readonly<Record<string, string>> }

export type AgentSessionDispatchOutcome =
  | ({
      state: 'accepted'
      providerIdentity: AgentJournalItemIdentity
    } & AgentSessionRanOptionsEvidence)
  /** Transport admission stays pending until provider acknowledgement; elapsed time never proves unknown delivery. */
  | ({ state: 'admitted' } & AgentSessionRanOptionsEvidence)
  /** Generate rejection words with agentSessionFailureWords; answeredInTurn identifies an already-ended answering turn. */
  | ({
      state: 'rejected'
      answeredInTurn?: AgentJournalAnsweredTurnIdentity
    } & AgentJournalDispatchRejection)
  /** Unsettled calls never authorize automatic resend. */
  | { state: 'unknown'; reason: string }

export type StructuredAgentSessionEndedEvent = {
  type: 'ended'
  sessionId: string
  /** Log only; failure supplies user-facing wording. */
  reason: string
  /** Absent means provider exit without extra detail; host faults retain their own classification. */
  failure?: SubmissionRejectionFact
  cause: 'unexpected-exit' | 'requested-close'
  /** Execution-host observations from a requested provider close, when available. */
  processExit?: {
    root: 'live' | 'unverifiable' | 'exited'
    workload: 'live' | 'unverifiable' | 'exited'
  }
  fence: number
  acquisitionGeneration: string
  /** Observed child exit supplies interrupted-turn end time. */
  observedAt?: number
  /** Failed startup proves none of its handed-over work ran. */
  startupUnanswered?: true
}

/** Readiness never waits for optional option reports. */
export type StructuredAgentSessionOptionsReportedEvent =
  StructuredAgentSessionProviderOpenResult & {
    type: 'options-reported'
    sessionId: string
    fence: number
    acquisitionGeneration: string
  }

export type StructuredAgentSessionLifecycleEvent =
  | StructuredAgentSessionEndedEvent
  | StructuredAgentSessionOptionsReportedEvent

export type StructuredAgentSessionProviderChildPhase = 'starting' | 'ready'

/** Host passes the whole startup attempt; optional fields permit minimal adapter test inputs. */
export type StructuredAgentSessionAcquireInput = Pick<
  StructuredAgentSessionStartupAttempt,
  'identity' | 'fence' | 'spawnToken'
> &
  Partial<Omit<StructuredAgentSessionStartupAttempt, 'identity' | 'fence' | 'spawnToken'>> & {
    recordPhase?: AgentSessionCreatePhaseRecorder
    /** Persist process identity before handshake so mid-start crashes leave a recoverable owner; returned process must match. */
    onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
  }

export type StructuredAgentSessionSetOptionInput = {
  sessionId: string
  key: string
  value: string
  fence: number
  /** Stop/close/quit aborts cannot wait for hung option writes; self-bounded adapters may ignore the signal. */
  signal?: AbortSignal
}

export type StructuredAgentSessionAdapter = StructuredAgentSessionAdapterStop & {
  open: StructuredAgentSessionProviderOpen
  supportsCreate?(location: AgentSessionExecutionLocation, agent: string): boolean
  /** Keep runtime/location support in adapter data for remote enablement. */
  supportsLocation?(location: AgentSessionExecutionLocation): boolean
  /** Spawn once per reservation; use its token/fence because the store rejects mismatched handles. */
  acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition>
  /** Reap failed acquisitions; true proves child exit, root-only proof throws AgentSessionAcquisitionRootExitObservedError. */
  releaseAcquisition?(input: { sessionId: string }): Promise<boolean>
  hasOwnedAcquisition?(sessionId: string): boolean
  stoppedAcquisition?(sessionId: string): StructuredAgentSessionAcquisitionReceipt | undefined
  dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    /** Apply immutable submission choices only to this dispatch. */
    executionOptions?: AgentSessionExecutionOptions
    /** Abort only before provider write, preserving the original signal reason so the host knows it was unwritten. */
    signal?: AbortSignal
    fence: number
    /** Preserve submission time as the opened turn’s requestedAt. */
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
    /** Mark preparation before choices mutate the provider. */
    onInputPreparation?: () => void
    /** Checkpoint between choice application and execution-evidence capture. */
    onExecutionSnapshot?: () => void
  }): Promise<AgentSessionDispatchOutcome>
  /** Narrow declared rewind per session; agent supplies the resting-session answer. */
  rewindSupport?(sessionId: string, agent?: string): AgentSessionRewindSupport
  /** Observe lost-reply rewind effects without repeating; keptTurnId null means no turns retained. */
  recoverRewind?(input: {
    sessionId: string
    fence: number
    signal?: AbortSignal
    beforeTurnId: string
    keptTurnId: string | null
  }): Promise<{ ok: true } | { ok: false; reason: AgentSessionRewindReason }>
  rewind?(input: {
    sessionId: string
    fence: number
    beforeTurnId: string
  }): Promise<{ ok: true } | { ok: false; reason: AgentSessionRewindReason }>
  /** Save the rewind fork before changing journal/record; refusals preserve the conversation, even at rest. */
  forkForRewind?(input: {
    record: AgentSessionRecord
    beforeMessage: { sessionId: string; uuid: string }
    rewindOperationId: string
  }): Promise<
    { ok: true; fork: AgentSessionRewindFork } | { ok: false; reason: AgentSessionRewindReason }
  >
  /** Return provider compaction admission; translator ends the command turn unless child-exit recovery does first. */
  compact?(input: {
    sessionId: string
    fence: number
    command: StructuredAgentSessionCommandRun
  }): Promise<AgentSessionCommandAdmission>
  /** Rejection proves refusal; thrown changes have unknown effects. */
  changeThreadGoal?(input: {
    sessionId: string
    fence: number
    change: AgentSessionThreadGoalChange
    /** Existing recorded goals require set to create a new objective, never rewrite the old one. */
    replacesGoal: boolean
    signal?: AbortSignal
  }): Promise<{ ok: true } | { ok: false; rejected: string }>
  /** Stop named tasks only; acknowledge each accepted stop immediately so later batch failures cannot erase it. */
  stopBackgroundTasks?(input: {
    sessionId: string
    fence: number
    taskIds: readonly string[]
    acknowledge?: (acknowledgement: AgentChildWorkStopAcknowledgement) => void
  }): Promise<{ cancelled: boolean; stillRunning?: true }>
  /** Undefined when no live session exposes stop support. */
  backgroundTaskStops?(sessionId: string): AgentSessionBackgroundTaskStops | undefined
  /** Derive unanswered retained work from the live child; false without one. */
  holdsDispatch?(sessionId: string): boolean
  /** Captures only this input's pending answer/output in the supplied live acquisition. */
  capturePendingOutput?(input: {
    sessionId: string
    clientMessageId: string
    fence: number
    generation: string
  }): (() => boolean) | undefined
  /** Undefined without a live child; then the host conservatively treats unanswered sends as held. */
  heldSends?(sessionId: string): ReadonlySet<string> | undefined
  /** Prove this acquisition’s root alive for lease renewal; absent/false falls back to PID probing. */
  holdsLiveProviderProcess?(sessionId: string, acquisitionGeneration: string): boolean
  /** Undefined preserves the client catalog when the provider reports none. */
  readCommands?(sessionId: string): AgentSessionSlashCommand[] | undefined
  atRestCommands?: StructuredAgentSessionAtRestCommands
  /** Claim the live callback, build reply, commit journal CAS, then answer; reject unbuildable replies before commit. */
  answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    response: AgentSessionPromptResponse
    fence: number
    commit: () => Promise<void>
  }): Promise<void>
  setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>>
  /** Synchronous capability projection; never acquires inventory or changes saved intent. */
  projectOptions?(
    sessionId: string,
    options: Readonly<Record<string, string>>
  ): StructuredAgentSessionOptionProjection | undefined
  /** Fetch outside the lane; apply under the same child’s fence. */
  prepareReadOptions?(input: {
    sessionId: string
    fence: number
  }): Promise<() => StructuredAgentSessionLiveOptions> | undefined
  readOptions?(input: {
    sessionId: string
    fence: number
  }): Promise<StructuredAgentSessionLiveOptions>
  readOptionRestoreFailures?(sessionId: string): readonly string[]
  /** Only consistent history boundaries can prove non-delivery; omitted windows leave unsettled sends unknown. */
  providerHistoryWindow?(input: {
    identity: AgentSessionJournalIdentity
    accountHome: AgentSessionAccountHome
  }): Promise<ProviderHistoryWindow | null>
  /** Copy the provider conversation without changing the chat’s ID; omit for CLI-based forks. */
  copyConversation?(input: {
    identity: AgentSessionJournalIdentity
    providerSessionId: string
    accountHome: AgentSessionAccountHome
  }): Promise<AiVaultConversationCopy>
  /** True proves child exit; root/processless verdicts throw only after finalization (stopAgentSessionProviderRoot). */
  closeSession?(sessionId: string): Promise<boolean>
  /** Sink-failure shutdown leaves exit recovery unexpected. */
  forceCloseSession?(sessionId: string): Promise<boolean>
  /** Teardown without requiring a future-resume cursor. */
  disposeSession?(sessionId: string): Promise<boolean>
  /** Acknowledge only after dead-child, lease and journal ownership release. */
  acknowledgeSessionRelease?(
    sessionId: string,
    acquisition?: StructuredAgentSessionAcquisitionReceipt
  ): void
}
