import type { JournalItemEcho } from '../agent-session-journal/journal-item-echo'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalLifecycleIdentityMutationInput } from '../agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionTransitionSink } from './structured-agent-session-transition'
import type {
  StructuredAgentSessionIdentityResolver,
  StructuredAgentSessionHistoryJournal,
  StructuredAgentSessionLinkageJournal,
  StructuredAgentSessionRevisionResolver
} from './structured-agent-session-journal-views'
import type { StructuredAgentSessionExitObservation } from './structured-agent-session-exit-observation'

export type StructuredAgentSessionSinkAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' }

export type StructuredAgentSessionSinkState = {
  queuedBytes: number
  queuedOperations: number
  backpressured: boolean
  failed: boolean
}

export type StructuredAgentSessionSinkBarrier = { ok: true } | { ok: false; error: unknown }

/** Omitted producer linkage means session/root agent. */
export type StructuredAgentSessionAppendOptions = AgentJournalProducerLinkage & {
  lifecycle?: boolean
  observedAt?: number
}

export type StructuredAgentSessionPublishOptions = Pick<
  StructuredAgentSessionAppendOptions,
  'lifecycle'
> & {
  coalescingKey?: string
}

/** Creation fixes turn scope; revisions keep it. */
export type StructuredAgentSessionItemAppendOptions = StructuredAgentSessionAppendOptions & {
  echoOf?: JournalItemEcho['echoOf']
  turnScope: AgentJournalTurnScope
  /** A later child execution assumes this reusable row. */
  executes?: true
}

export type StructuredAgentSessionRevisionOptions = StructuredAgentSessionItemAppendOptions

export type StructuredAgentSessionEventSink = StructuredAgentSessionTransitionSink & {
  observeExit?: StructuredAgentSessionExitObservation['record']
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ): void
  appendTombstone(
    identity: AgentJournalItemIdentity,
    options?: StructuredAgentSessionAppendOptions
  ): void
  tryAppendTombstone?(
    identity: AgentJournalItemIdentity,
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  publish(options?: StructuredAgentSessionPublishOptions): void
  /** Not ok if any admitted write failed or close dropped it unwritten. */
  written?(): Promise<StructuredAgentSessionSinkBarrier>
  setActivity?(activity: AgentSessionTurnActivity | null): void
  tryAppendItem?(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  tryAppendResolvedItem?(
    identitySizeBound: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    resolveIdentity: StructuredAgentSessionIdentityResolver,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  tryAppendResolvedItemAndPublish?(
    identitySizeBound: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    resolveIdentity: StructuredAgentSessionIdentityResolver,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  /** Reserved bytes must bound the eventual resolved revision. */
  tryReviseResolvedItem?(
    reservedBytes: number,
    resolve: StructuredAgentSessionRevisionResolver,
    options: StructuredAgentSessionRevisionOptions
  ): StructuredAgentSessionSinkAdmission
  tryReviseResolvedItemAndPublish?(
    reservedBytes: number,
    resolve: StructuredAgentSessionRevisionResolver,
    options: StructuredAgentSessionRevisionOptions
  ): StructuredAgentSessionSinkAdmission
  /** Resolve on the journal lane; null appends nothing. */
  tryAppendLifecycleTransition?(
    identitySizeBound: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    resolveIdentity: StructuredAgentSessionIdentityResolver,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  journalEpoch?(): string | null
  journalLinkage?(): StructuredAgentSessionLinkageJournal | null
  journalHistory?(): StructuredAgentSessionHistoryJournal | null
  /** Apply the journal’s personal-Stop cancellation rule; false until bound. */
  journalStopDecidesTurn?(turnId: string, endedAt: number): boolean
  appendLifecycleBatch?(
    settlementId: string,
    mutations: readonly JournalLifecycleIdentityMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission | void
  tryAppendLifecycleBatch?(
    settlementId: string,
    mutations: readonly JournalLifecycleIdentityMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  tryPublish?(options?: StructuredAgentSessionPublishOptions): StructuredAgentSessionSinkAdmission
  /** Couples durable-queue pressure to the exact provider stream producing it. */
  bindReadingControl?(control: StructuredAgentSessionReadingControl): () => void
}

export type StructuredAgentSessionEventTarget = {
  journal: AgentSessionJournal
  fence: number
  publish: (activity?: AgentSessionTurnActivity | null) => void
}

export type DeferredStructuredAgentSessionEventSink = {
  sink: StructuredAgentSessionEventSink
  exitObservation(): Omit<StructuredAgentSessionExitObservation, 'record'>
  bind(target: StructuredAgentSessionEventTarget): void
  unbind(): void
  close(): void
  drained(): Promise<StructuredAgentSessionSinkBarrier>
  lifecycleBarrier(): Promise<StructuredAgentSessionSinkBarrier>
  state(): StructuredAgentSessionSinkState
}

export type StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: number
  lowQueuedBytes: number
  pauseQueuedOperations: number
  lowQueuedOperations: number
}

export type StructuredAgentSessionReadingControl = {
  pauseReading(): void
  resumeReading(): void
}
