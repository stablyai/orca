import type { AgentSessionAccountKind } from '../../../shared/agent-session-availability'
import type {
  AgentSessionRewindReason,
  AgentSessionRewindSupport
} from '../../../shared/agent-session-rewind'
// What the wire needs from a provider adapter.
//
// Phase 2 implements this over the Codex app-server and the Claude Agent SDK;
// nothing here starts, resumes, or talks to a process. The wire owns the
// journal and the lease, so an adapter only has to answer "did the provider
// take this?" — and it answers `unknown` rather than guessing, because the
// journal renders that as delivery unconfirmed instead of as failure.

import type { AgentSessionBackgroundTaskStops } from '../../../shared/agent-child-work-stop-targets'
import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalItemIdentity,
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalDispatchState,
  AgentJournalTurnItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'
import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand,
  AgentSessionThreadGoalChange
} from '../../../shared/agent-session-wire'
import type { AgentSessionRefusalReason } from '../../../shared/agent-session-wire-refusals'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type {
  AgentSessionCancelOutcome,
  StructuredAgentSessionAdapterStop
} from './structured-agent-session-adapter-stop'
export type { AgentSessionCancelOutcome } from './structured-agent-session-adapter-stop'
export type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionStopCause
} from './structured-agent-session-stop-cause'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'
import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'

export class AgentSessionAcquisitionRefusal extends Error {
  readonly code = 'agent_session_operation_invalid'

  constructor(
    message: string,
    /** The situation, so the chat can say what to do; the message is Orca's log wording. Absent,
     *  the provider refused its own start. */
    readonly reason: AgentSessionRefusalReason<'agent_session_operation_invalid'> = 'providerStartFailed',
    readonly account?: AgentSessionAccountKind
  ) {
    super(message)
    this.name = 'AgentSessionAcquisitionRefusal'
  }

  /** The conversation's history is more than this host can restore. */
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

/** The provider cannot take this answer. Thrown before the journal commit, so nothing is recorded. */
export class AgentSessionPromptAnswerRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionPromptAnswerRejectedError'
  }
}

/**
 * The provider's own root process was observed to exit, but its descendant tree
 * was not proven gone. The lease keys on the root's pid and start time, so its
 * observed death releases the reservation; nothing is claimed about descendants,
 * including one seen still alive.
 */
export class AgentSessionAcquisitionRootExitObservedError extends Error {
  constructor(cause: unknown) {
    // The provider's own diagnostic is the only thing the user can act on.
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionRootExitObservedError'
  }
}

/** The provider child failed and cleanup proved its whole tree gone — on Windows, that its root
 *  left on its own after stdin end (descendants not addressed, as with Codex) or taskkill reported
 *  the tree terminated. As with a root exit, the provider's own diagnostic is the message. */
export class AgentSessionAcquisitionExitProvenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionExitProvenError'
  }
}

export class AgentSessionAcquisitionExitUnprovenError extends Error {
  constructor(cause: unknown) {
    super('agent_session_acquisition_exit_unproven', { cause })
    this.name = 'AgentSessionAcquisitionExitUnprovenError'
  }
}

/** What a reservation turns into once something is actually running under it:
 *  the process the host can probe, and the provider handle it was minted with. */
export type AgentSessionAcquisition = {
  process: AgentSessionProcessIdentity
  link: AgentSessionProviderHandleLink
  /** Host-local identity for this exact provider child, distinct even when the durable fence is
   *  reused by a superseding acquisition. */
  acquisitionGeneration?: string
  /** `starting`: published at spawn, proven later by a `started` event. Absent means `ready`, an
   *  acquire that ran the whole handshake before answering; that bridge ends once every adapter
   *  publishes at spawn. Either way the host holds input until the child is `ready`. */
  providerChildPhase?: StructuredAgentSessionProviderChildPhase
}

/** A refusal before spawn that a person can act on; the site that refused names it. */
export type AgentSessionPreSpawnReason = Extract<
  AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  | 'managedAccountEnvOverride'
  | 'accountSwitchInProgress'
  | 'managedAccountUnsupported'
  | 'launchFolderMissing'
  | 'historyInOtherAccount'
  | 'agentCommandNotRunnable'
>

/** Acquisition failed with first-hand proof that no provider process existed. */
export class AgentSessionPreSpawnError extends Error {
  /** Absent: Orca's own reason, which only the log reads. A wrapped pre-spawn error keeps its. */
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

/** A conversation command the host handed to a provider child: the running turn it opened for it,
 *  which the child's translator ends, and where the command's own result row goes. */
export type StructuredAgentSessionCommandRun = {
  clientMessageId: string
  /** What a Stop names. */
  turnId: string
  identity: AgentJournalItemIdentity
  resultIdentity: AgentJournalItemIdentity
  /** The turn record as the host wrote it; the translator's end revises it. */
  running: AgentJournalTurnItem
}

/** A command the provider took answers it in place and echoes no item of its own. */
export type AgentSessionCommandAdmission =
  | AgentSessionDispatchOutcome
  | { state: 'accepted'; providerIdentity: null }

export type AgentSessionDispatchOutcome =
  /** The provider owns the turn now, under this identity. */
  | { state: 'accepted'; providerIdentity: AgentJournalItemIdentity }
  /**
   * The provider transport took the message; identity settles later, out of band.
   * The submission stays `pending`: a message queued behind a running turn is
   * acknowledged only when that turn starts, so elapsed time is not evidence of
   * anything and never promotes this to `unknown`.
   */
  | { state: 'admitted' }
  /** Words from `agentSessionFailureWords`, never written by hand. `answeredInTurn`: the turn the
   *  provider answered the send into, which ended before the answer was read. */
  | ({
      state: 'rejected'
      answeredInTurn?: AgentJournalAnsweredTurnIdentity
    } & AgentJournalDispatchRejection)
  /** The call did not settle. Never re-send on the user's behalf. */
  | { state: 'unknown'; reason: string }

export type StructuredAgentSessionEndedEvent = {
  type: 'ended'
  sessionId: string
  /** Log text only; the chat's words come from `failure`. */
  reason: string
  /** Why it ended, as the adapter knows it: the provider's exit with its own diagnostic, or an
   *  Orca fault. Absent reads as a provider exit with nothing to add. */
  failure?: SubmissionRejectionFact
  cause: 'unexpected-exit' | 'requested-close'
  fence: number
  acquisitionGeneration: string
  /** Host receipt of the child exit: the end time of a turn it interrupted. */
  observedAt?: number
  /** The provider ended before it finished starting, so resuming it would repeat the failure. */
  startupUnproven?: true
  /** The provider ended before it answered its start, so it ran nothing it was handed. */
  startupUnanswered?: true
}

/** The child a publish-first acquire handed over has now proven its start: startup facts applied.
 *  What it reports from here on is fact, not a catalog guess. */
export type StructuredAgentSessionStartedEvent = {
  type: 'started'
  sessionId: string
  fence: number
  acquisitionGeneration: string
  /** What the child proved, snapshotted by the adapter from what startup already read. The host
   *  handles this inside the session's serialized step, so it must not ask the CLI. */
  reportedOptions: AgentSessionOptionsResult['current']
  /** Saved options the child could not take; the host drops them rather than persist them. */
  restoreSkippedOptions: readonly string[]
  /** Values the child showed it cannot run: a report naming the same value is not persisted. */
  retiredOptions?: Readonly<Record<string, string>>
  /** The attempt's `optionRevision()` as the read behind this report began: a pick the host took
   *  since makes it out of date. An earlier report never does, whenever the host took it. */
  optionRevision: number
}

/** A running child showed saved options it cannot run, as a model the provider reports missing.
 *  The record drops them, so the next start uses the provider's own. */
export type StructuredAgentSessionOptionsSkippedEvent = {
  type: 'options-skipped'
  sessionId: string
  fence: number
  acquisitionGeneration: string
  /** Each saved value the child showed it cannot run; a record holding another value keeps it. */
  options: Readonly<Record<string, string>>
}

/** What a child that already proved its start reports later, such as an optional read that came
 *  after `started`: persisted as the start's report is. Never delays a start. */
export type StructuredAgentSessionOptionsReportedEvent = Omit<
  StructuredAgentSessionStartedEvent,
  'type'
> & { type: 'options-reported' }

export type StructuredAgentSessionLifecycleEvent =
  | StructuredAgentSessionEndedEvent
  | StructuredAgentSessionStartedEvent
  | StructuredAgentSessionOptionsReportedEvent
  | StructuredAgentSessionOptionsSkippedEvent

/** Whether the provider child behind an acquisition has proven its start. A publish-first
 *  acquire hands over a `starting` child, which the host gives no input until the `started`
 *  lifecycle event flips it. */
export type StructuredAgentSessionProviderChildPhase = 'starting' | 'ready'

/** The host's startup attempt (`structured-agent-session-startup-attempt`), which the host always
 *  passes whole. Only the fields every caller has are required, so an adapter test may pass less. */
export type StructuredAgentSessionAcquireInput = Pick<
  StructuredAgentSessionStartupAttempt,
  'identity' | 'fence' | 'spawnToken'
> &
  Partial<Omit<StructuredAgentSessionStartupAttempt, 'identity' | 'fence' | 'spawnToken'>> & {
    recordPhase?: AgentSessionCreatePhaseRecorder
    /** Durably records the child's identity the moment it exists, before any handshake, so a crash
     *  mid-start leaves an owner recovery can stop. The acquisition's `process` must match it. */
    onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
  }

export type StructuredAgentSessionSetOptionInput = {
  sessionId: string
  key: string
  value: string
  fence: number
  /** Aborted by a close, a Stop admitted now, or quit, which must not wait behind a pick the
   *  provider never answers: the write fails. An adapter that bounds its own write may ignore it. */
  signal?: AbortSignal
}

export type StructuredAgentSessionAdapter = StructuredAgentSessionAdapterStop & {
  /** Provider-aware capability check for hosts that route more than one adapter. */
  supportsCreate?(location: AgentSessionExecutionLocation, agent: string): boolean
  /** Provider/runtime support, kept here so remote enablement changes adapter data, not UI logic. */
  supportsLocation?(location: AgentSessionExecutionLocation): boolean
  /** Makes the reservation real. Called once per reservation, with the spawn
   *  token the lease was reserved under and the fence the handle must be minted
   *  at — the store rejects a link minted at any other fence. */
  acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition>
  /** Reaps an acquired provider when the host cannot commit or prove its lease.
   *  Returns true only after provider child exit is proven. Throws
   *  `AgentSessionAcquisitionRootExitObservedError` when the provider root's own
   *  exit was observed first-hand but its descendants were not proven gone. */
  releaseAcquisition?(input: { sessionId: string }): Promise<boolean>
  dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    /** Host clock on the submission row this send came from; the origin the turn
     *  it opens records as `requestedAt`. */
    requestedAt?: number
    /** Revalidate after preparation, immediately before writing to the provider. */
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome>
  /** How this session narrows its agent's declared rewind; `agent` answers for one with no child
   *  running. The router applies the declaration first, so an adapter's answer never widens it. */
  rewindSupport?(sessionId: string, agent?: string): AgentSessionRewindSupport
  recoverRewind?(input: {
    sessionId: string
    fence: number
    beforeTurnId: string
  }): Promise<
    | { ok: true; items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] }
    | { ok: false; reason: AgentSessionRewindReason }
  >
  rewind?(input: {
    sessionId: string
    fence: number
    beforeTurnId: string
    onPrepared?: (
      items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]
    ) => Promise<void>
  }): Promise<
    | { ok: true; items?: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] }
    | { ok: false; reason: AgentSessionRewindReason }
  >
  /** Sends a conversation compaction and answers with the provider's receipt of it, as a dispatch
   *  does. The command's turn is the child's journal translator's to end, from the provider's own
   *  frames; a child that ends first leaves it to the host's settlement of that child. */
  compact?(input: {
    sessionId: string
    fence: number
    command: StructuredAgentSessionCommandRun
  }): Promise<AgentSessionCommandAdmission>
  /** Cancels one turn, not the session: a session-wide interrupt would also kill
   *  a turn the client never asked to stop. With no `turnId` the conversation asked to stop
   *  everything it has in flight — a running turn, or a dispatch whose turn has not opened yet. */
  cancelTurn(input: {
    sessionId: string
    turnId?: string
    fence: number
    prompt?: { itemId: string }
    /** Latest journal submission for this fence, when the host has one. */
    dispatchStatus?: { state: AgentJournalDispatchState; recovered: boolean } | null
    /** Re-reads the turn the published journal says is running — the only turn a client
     *  could have named. A function, not a value, because the guard reads it when the
     *  interrupt is issued. Absent for direct callers with no journal. */
    resolveLiveTurnId?: () => string | null
  }): Promise<AgentSessionCancelOutcome>
  /** Changes the provider thread's goal. `rejected` is the provider refusing the
   *  change; a throw leaves its effect unknown. Absent where no goal exists. */
  changeThreadGoal?(input: {
    sessionId: string
    fence: number
    change: AgentSessionThreadGoalChange
    /** True when the journal records a goal, whatever its status: a `set` must
     *  start a new goal rather than rewrite that one's objective in place. */
    replacesGoal: boolean
  }): Promise<{ ok: true } | { ok: false; rejected: string }>
  /** Stops exactly the tasks `taskIds` names, which the host resolves from its child records. */
  stopBackgroundTasks?(input: {
    sessionId: string
    fence: number
    taskIds: readonly string[]
  }): Promise<{ cancelled: boolean }>
  /** The stops this provider honours for a live session's background work; undefined when the
   *  adapter holds no live session for it. */
  backgroundTaskStops?(sessionId: string): AgentSessionBackgroundTaskStops | undefined
  /** The provider reported taking a send it has neither answered nor ended, as a queued follow-up
   *  or a silent retry does. Derived from the live child; false with none. */
  holdsDispatch?(sessionId: string): boolean
  /** The adapter's own child for this exact acquisition has a pid and its root exit has not been
   *  seen: first-hand proof of life for lease renewal. Absent or false falls back to a PID probe. */
  holdsLiveProviderProcess?(sessionId: string, acquisitionGeneration: string): boolean
  /** The `/` surface the running provider reports for itself. Undefined when the
   *  provider never reports one, which is what keeps the client on its catalog. */
  readCommands?(sessionId: string): AgentSessionSlashCommand[] | undefined
  /** The `/` surface of a chat whose agent is not running; absent when the provider has none. */
  atRestCommands?: StructuredAgentSessionAtRestCommands
  /** Claims the live callback, builds the provider reply, commits the journal CAS while that claim is
   *  held, then answers it. A reply that cannot be built throws `AgentSessionPromptAnswerRejectedError`
   *  before the commit. A prompt cancel claims the same callback, so only one operation can commit. */
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
  /** Resolves once a live session can take an option write, or after a bound; never rejects. */
  awaitOptionWritable?(sessionId: string): Promise<void>
  /** False while the live child has not answered its start, so it has run nothing it was handed.
   *  Absent or undefined reads as answered. */
  startAnswered?(sessionId: string): boolean | undefined
  /** Fetch off the lane, then apply the result under the same child's fence. */
  prepareReadOptions?(input: {
    sessionId: string
    fence: number
  }): Promise<() => AgentSessionOptionsResult> | undefined
  readOptions?(input: { sessionId: string; fence: number }): Promise<AgentSessionOptionsResult>
  /** Effective options already known after acquisition, without discovering picker choices. */
  readAcquisitionOptions?(input: {
    sessionId: string
    fence: number
    priorOptions?: Readonly<Record<string, string>>
  }):
    | Promise<Readonly<Record<string, string>> | undefined>
    | Readonly<Record<string, string>>
    | undefined
  /** Option keys skipped after a provider rejected their persisted restore value. */
  readOptionRestoreFailures?(sessionId: string): readonly string[]
  /** Provider history for restart reconciliation, read from the resume point
   *  `identity.providerHandle` names. Only the adapter can say
   *  whether the read has a proven start and whether a turn is still running, so
   *  it owns both flags. Omit where the provider records no boundary-consistent
   *  history; an omitted window leaves every unsettled submission `unknown`. */
  providerHistoryWindow?(input: {
    identity: AgentSessionJournalIdentity
    accountHome: AgentSessionAccountHome
  }): Promise<ProviderHistoryWindow | null>
  /** Gracefully stops the structured owner after its event stream is drained. */
  /** Returns true only after the provider child exit is proven. A root-exit or processless verdict
   *  is thrown only once the session is finalized; read it through `stopAgentSessionProviderRoot`. */
  closeSession?(sessionId: string): Promise<boolean>
  /** Stops a provider after a sink failure; the resulting exit is recovered as unexpected. */
  forceCloseSession?(sessionId: string): Promise<boolean>
  /** Stops a provider child for teardown without requiring a future-resume cursor. */
  disposeSession?(sessionId: string): Promise<boolean>
  /** Host acknowledgement that the proven-dead child, lease and journal owner are released. */
  acknowledgeSessionRelease?(sessionId: string): void
}
