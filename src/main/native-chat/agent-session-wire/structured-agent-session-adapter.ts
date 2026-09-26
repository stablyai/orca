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

import type {
  AgentJournalItemIdentity,
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalDispatchState,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionOptionsResult,
  AgentSessionSlashCommand,
  AgentSessionThreadGoalChange,
  AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire'
import {
  isAgentSessionWireRefusalCode,
  type AgentSessionRefusalCause
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredSessionCompactionResult } from './structured-session-compaction'
import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'

export class AgentSessionAcquisitionRefusal extends Error {
  constructor(
    message: string,
    readonly code: AgentSessionWireRefusalCode = 'agent_session_operation_invalid',
    /** The situation, so the chat can say what to do; the message is Orca's log wording. */
    readonly refusalCause?: AgentSessionRefusalCause
  ) {
    super(message)
    this.name = 'AgentSessionAcquisitionRefusal'
  }
}

export class AgentSessionPromptUnavailableError extends Error {
  constructor(itemId: string) {
    super(`The provider is no longer waiting on ${itemId}.`)
    this.name = 'AgentSessionPromptUnavailableError'
  }
}

/**
 * The provider's own root process was observed to exit, but its descendant tree
 * could not be verified. The lease keys on the root's pid and start time, so its
 * observed death releases the reservation; nothing is claimed about descendants.
 * Never thrown when a descendant was observed still alive — that stays unproven.
 */
export class AgentSessionAcquisitionRootExitObservedError extends Error {
  constructor(cause: unknown) {
    // The provider's own diagnostic is the only thing the user can act on.
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionRootExitObservedError'
  }
}

/** The provider child failed and cleanup proved its whole tree gone. As with a root exit, the
 *  provider's own diagnostic is the message. */
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
  /** Absent means `ready`: the adapter proved startup before answering. */
  providerChildPhase?: StructuredAgentSessionProviderChildPhase
}

/** Acquisition failed with first-hand proof that no provider process existed. */
export class AgentSessionPreSpawnError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionPreSpawnError'
  }
}

export function isAgentSessionPreSpawnError(error: unknown): error is AgentSessionPreSpawnError {
  return error instanceof Error && error.name === 'AgentSessionPreSpawnError'
}

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
  | { state: 'rejected'; reason: string; rejection: AgentSessionFailureFact }
  /** The call did not settle. Never re-send on the user's behalf. */
  | { state: 'unknown'; reason: string }

export type StructuredAgentSessionEndedEvent = {
  type: 'ended'
  sessionId: string
  /** Log text only; the chat's words come from `failure`. */
  reason: string
  /** Why it ended, as the adapter knows it: the provider's exit with its own diagnostic, or an
   *  Orca fault. Absent reads as a provider exit with nothing to add. */
  failure?: AgentSessionFailureFact
  cause: 'unexpected-exit' | 'requested-close'
  fence: number
  acquisitionGeneration: string
  /** Host receipt of the child exit, retained across settlement retries. */
  observedAt?: number
  /** Translator could not admit terminal rows; host recovery must append its bounded fallback. */
  settlementRetryRequired?: boolean
  /** The provider ended before it finished starting, so resuming it would repeat the failure. */
  startupUnproven?: true
}

/** The child a publish-first acquire handed over has now proven its start: startup facts applied
 *  and saved options restored. What it reports from here on is fact, not a catalog guess. */
export type StructuredAgentSessionStartedEvent = {
  type: 'started'
  sessionId: string
  fence: number
  acquisitionGeneration: string
  /** What the child proved, snapshotted by the adapter from what startup already read. The host
   *  handles this inside the session's serialized step, so it must not ask the CLI. */
  reportedOptions: AgentSessionOptionsResult['current']
  /** Saved options the restore could not apply; the host drops them rather than persist them. */
  restoreSkippedOptions: readonly string[]
}

export type StructuredAgentSessionLifecycleEvent =
  | StructuredAgentSessionEndedEvent
  | StructuredAgentSessionStartedEvent

/** Whether the provider child behind an acquisition has proven its start. A publish-first
 *  acquire hands over a `starting` child and the `started` lifecycle event flips it. */
export type StructuredAgentSessionProviderChildPhase = 'starting' | 'ready'

export type StructuredAgentSessionAcquireInput = {
  identity: AgentSessionJournalIdentity
  fence: number
  spawnToken: string
  options?: Readonly<Record<string, string>>
  /** Provider events may begin before acquisition returns. */
  events?: StructuredAgentSessionEventSink
  recordPhase?: AgentSessionCreatePhaseRecorder
}

export type StructuredAgentSessionSetOptionInput = {
  sessionId: string
  key: string
  value: string
  fence: number
}

export type StructuredAgentSessionAdapter = {
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
   *  exit was observed first-hand but its descendants could not be verified. */
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
  rewindSupport?(sessionId: string): AgentSessionRewindSupport
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
    onReverted?: () => Promise<void>
  }): Promise<
    | { ok: true; items?: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] }
    | { ok: false; reason: AgentSessionRewindReason }
  >
  compact?(input: {
    turnId: string
    sessionId: string
    fence: number
    onLateResult?: (result: StructuredSessionCompactionResult) => Promise<void>
  }): Promise<StructuredSessionCompactionResult>
  /** Cancels one turn, not the session: a session-wide interrupt would also kill
   *  a turn the client never asked to stop. */
  cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
    prompt?: { itemId: string }
    /** Latest journal submission for this fence, when the host has one. */
    dispatchStatus?: { state: AgentJournalDispatchState; recovered: boolean } | null
    /** Re-reads the turn the published journal says is running — the only turn a client
     *  could have named. A function, not a value, because the guard re-checks after the
     *  delivery fence may have waited. Absent for direct callers with no journal. */
    resolveLiveTurnId?: () => string | null
  }): Promise<{ cancelled: boolean }>
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
  /** Whether this live session can change its goal. */
  supportsThreadGoal?(sessionId: string): boolean
  /** Whether this live session writes context facts to its turn rows. */
  recordsContextUsage?(sessionId: string): boolean
  stopBackgroundTasks?(input: {
    sessionId: string
    fence: number
    taskId?: string
  }): Promise<{ cancelled: boolean }>
  backgroundTaskState?(sessionId: string): AgentSessionBackgroundTaskState | null | undefined
  /** The `/` surface the running provider reports for itself. Undefined when the
   *  provider never reports one, which is what keeps the client on its catalog. */
  readCommands?(sessionId: string): AgentSessionSlashCommand[] | undefined
  /** Claims the live callback, commits the journal CAS while that claim is held, then answers it.
   *  A prompt cancel claims the same callback, so only one operation can commit. */
  answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
    commit: () => Promise<void>
  }): Promise<void>
  setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>>
  /** Resolves once a live session can take an option write, or after a bound; never rejects. */
  awaitOptionWritable?(sessionId: string): Promise<void>
  /** Resolves once a session published before it proved its start has proven it, failed, or been
   *  closed; at once for any other. A start that did not land resolves with the chat's words for
   *  why. Never rejects. */
  awaitStarted?(sessionId: string): Promise<void | AgentSessionFailureFact>
  readOptions?(input: { sessionId: string; fence: number }): Promise<AgentSessionOptionsResult>
  /** Option keys skipped after a provider rejected their persisted restore value. */
  readOptionRestoreFailures?(sessionId: string): readonly string[]
  /** Transcript path for journal recovery. Omit to let the existing session-file
   *  resolver discover it from the provider session id. */
  historyFilePath?(input: { identity: AgentSessionJournalIdentity }): Promise<string | null>
  /** Provider history for restart reconciliation, bounded to what the provider
   *  recorded after the journal's last committed item. Only the adapter can say
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

export async function rethrowAfterAgentSessionAcquisitionCleanup(
  adapter: Pick<StructuredAgentSessionAdapter, 'releaseAcquisition'>,
  sessionId: string,
  cause: unknown
): Promise<never> {
  let released: boolean
  try {
    released = (await adapter.releaseAcquisition?.({ sessionId })) === true
  } catch (cleanupError) {
    // A root exit the cleanup observed first-hand keeps its classification and its
    // provider diagnostic; the failure that triggered cleanup rides along as cause.
    throw cleanupError instanceof AgentSessionAcquisitionRootExitObservedError
      ? new AgentSessionAcquisitionRootExitObservedError(
          new AggregateError([cause, cleanupError], cleanupError.message)
        )
      : new AgentSessionAcquisitionExitUnprovenError(
          new AggregateError([cause, cleanupError], 'agent session acquisition cleanup failed')
        )
  }
  if (released) {
    throw provenExitAcquisitionFailure(cause)
  }
  throw new AgentSessionAcquisitionExitUnprovenError(cause)
}

/** A failure whose child cleanup proved gone. One that already names its own verdict — a
 *  refusal, a typed exit proof, or a host store code — keeps it. */
function provenExitAcquisitionFailure(cause: unknown): unknown {
  const classified =
    cause instanceof AgentSessionAcquisitionRefusal ||
    cause instanceof AgentSessionAcquisitionRootExitObservedError ||
    cause instanceof AgentSessionAcquisitionExitUnprovenError ||
    isAgentSessionPreSpawnError(cause) ||
    (cause instanceof Error && isAgentSessionWireRefusalCode(cause.message))
  return classified ? cause : new AgentSessionAcquisitionExitProvenError(cause)
}

/** Whether a stop left the provider root gone. The lease follows the root, so a first-hand root
 *  exit or a processless child ends the session even with descendants unverified; any other
 *  failure, including known-live descendants, still throws. */
export async function stopAgentSessionProviderRoot(stop: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await stop()) === true
  } catch (error) {
    if (
      error instanceof AgentSessionAcquisitionRootExitObservedError ||
      isAgentSessionPreSpawnError(error)
    ) {
      return true
    }
    throw error
  }
}
