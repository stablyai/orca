import {
  DEFAULT_WATERMARKS,
  type StructuredAgentSessionSinkWatermarks,
  type StructuredAgentSessionSinkAdmission,
  type StructuredAgentSessionSinkState,
  type StructuredAgentSessionSinkBarrier
} from './structured-agent-session-sink-admission'
export type { StructuredAgentSessionSinkWatermarks } from './structured-agent-session-sink-admission'
import {
  createStructuredAgentSessionTextAppend,
  type StructuredAgentSessionTextSink
} from './structured-agent-session-text-append'
export type {
  StructuredAgentSessionSinkAdmission,
  StructuredAgentSessionSinkState,
  StructuredAgentSessionSinkBarrier
} from './structured-agent-session-sink-admission'
import type { JournalTextAdmission } from '../agent-session-journal/journal-text-rows'
import type { JournalItemEcho } from '../agent-session-journal/journal-item-echo'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalLifecycleIdentityMutationInput } from '../agent-session-journal/journal-row-builders'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import { createStructuredAgentSessionResolvedAppend } from './structured-agent-session-resolved-append'
import {
  createStructuredAgentSessionTransitionMembers,
  type StructuredAgentSessionTransitionSink
} from './structured-agent-session-transition'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type {
  StructuredAgentSessionIdentityResolver,
  StructuredAgentSessionHistoryJournal,
  StructuredAgentSessionLinkageJournal,
  StructuredAgentSessionRevisionResolver
} from './structured-agent-session-journal-views'
export type {
  StructuredAgentSessionLifecycleJournal,
  StructuredAgentSessionIdentityResolver,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionHistoryJournal,
  StructuredAgentSessionLinkageJournal,
  StructuredAgentSessionRevisionResolver
} from './structured-agent-session-journal-views'
import { StructuredAgentSessionExitObservation } from './structured-agent-session-exit-observation'

/** Linkage a producer stamps on the rows it writes. Absent on every append the
 *  session's own agent makes, which is what makes absence mean root. */
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
  rawTextKey?: string
  retireText?: true
  streamText?: JournalTextAdmission
  applied?: () => void
  echoOf?: JournalItemEcho['echoOf']
  turnScope: AgentJournalTurnScope
  /** A later child execution assumes this reusable row. */
  executes?: true
}

export type StructuredAgentSessionRevisionOptions = StructuredAgentSessionItemAppendOptions

export type StructuredAgentSessionEventSink = StructuredAgentSessionTransitionSink &
  StructuredAgentSessionTextSink & {
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
    /** Resolves `ok` once every write admitted so far has landed in the journal; not `ok` when one
     *  failed or a close dropped it unwritten. */
    written?(): Promise<StructuredAgentSessionSinkBarrier>
    setActivity?(activity: AgentSessionTurnActivity | null): void
    tryAppendItem?(
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      options: StructuredAgentSessionItemAppendOptions
    ): StructuredAgentSessionSinkAdmission
    tryAppendStreamedItem?(
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      options: StructuredAgentSessionItemAppendOptions
    ): StructuredAgentSessionSinkAdmission
    /** Queues an ordinary append whose identity is resolved after journal bind. */
    tryAppendResolvedItem?(
      identitySizeBound: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      resolveIdentity: StructuredAgentSessionIdentityResolver,
      options: StructuredAgentSessionItemAppendOptions
    ): StructuredAgentSessionSinkAdmission
    /** Queues one resolved append and its publication as a single admitted operation. */
    tryAppendResolvedItemAndPublish?(
      identitySizeBound: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      resolveIdentity: StructuredAgentSessionIdentityResolver,
      options: StructuredAgentSessionItemAppendOptions
    ): StructuredAgentSessionSinkAdmission
    /** Queues a read-modify-write of one row; `reservedBytes` must bound the resolved write. */
    tryReviseResolvedItem?(
      reservedBytes: number,
      resolve: StructuredAgentSessionRevisionResolver,
      options: StructuredAgentSessionRevisionOptions
    ): StructuredAgentSessionSinkAdmission
    /** Queues one revision and its publication as a single admitted operation. */
    tryReviseResolvedItemAndPublish?(
      reservedBytes: number,
      resolve: StructuredAgentSessionRevisionResolver,
      options: StructuredAgentSessionRevisionOptions
    ): StructuredAgentSessionSinkAdmission
    /** Queues one journal-derived lifecycle append; a null resolution is a no-op. */
    tryAppendLifecycleTransition?(
      identitySizeBound: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      resolveIdentity: StructuredAgentSessionIdentityResolver,
      options: StructuredAgentSessionItemAppendOptions
    ): StructuredAgentSessionSinkAdmission
    /** Current durable epoch, when this deferred sink is bound to its journal. */
    journalEpoch?(): string | null
    /** The bound journal's producer linkage; null until bound. */
    journalLinkage?(): StructuredAgentSessionLinkageJournal | null
    /** The bound journal's rows and current epoch; null until bound. */
    journalHistory?(): StructuredAgentSessionHistoryJournal | null
    /** Whether the bound journal's Stop rule makes turn `turnId`, ending at `endedAt` with no verdict
     *  of its own, a person's cancellation (`personStopDecidesTurn`); false until bound. */
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
  exitObservation(): Pick<StructuredAgentSessionExitObservation, 'heldSends' | 'observedAt'>
  bind(target: StructuredAgentSessionEventTarget): void
  unbind(): void
  close(): void
  drained(): Promise<StructuredAgentSessionSinkBarrier>
  lifecycleBarrier(): Promise<StructuredAgentSessionSinkBarrier>
  state(): StructuredAgentSessionSinkState
}

export type StructuredAgentSessionReadingControl = {
  pauseReading(): void
  resumeReading(): void
}

export function createDeferredStructuredAgentSessionEventSink(deps: {
  sessionId: string
  logger: StructuredAgentSessionLogger
  /** Permanent failure; owner decides whether the provider can continue. */
  onFailed?: (error: unknown) => void
  watermarks?: Partial<StructuredAgentSessionSinkWatermarks>
  readingControl?: StructuredAgentSessionReadingControl
  onBackpressureChange?: (backpressured: boolean, state: StructuredAgentSessionSinkState) => void
}): DeferredStructuredAgentSessionEventSink {
  const exit = new StructuredAgentSessionExitObservation()
  const watermarks = { ...DEFAULT_WATERMARKS, ...deps.watermarks }
  const failed = (error: unknown): void => {
    deps.logger.error('writing provider events to the chat journal failed', {
      scope: 'journal-event-sink',
      sessionId: deps.sessionId,
      error
    })
    deps.onFailed?.(error)
  }
  const queue = new StructuredAgentSessionSinkQueue({
    watermarks,
    onFailed: failed,
    ...(deps.readingControl ? { readingControl: deps.readingControl } : {}),
    ...(deps.onBackpressureChange ? { onBackpressureChange: deps.onBackpressureChange } : {})
  })
  const text = createStructuredAgentSessionTextAppend(queue)
  const resolvedAppend = createStructuredAgentSessionResolvedAppend(queue, text.hold)

  const appendLifecycleBatch = (
    settlementId: string,
    mutations: readonly JournalLifecycleIdentityMutationInput[],
    options: StructuredAgentSessionAppendOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit(
      {
        bytes: Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512,
        run: (bound) =>
          bound.journal.appendLifecycleBatch({
            settlementId,
            mutations,
            // Preserve per-mutation linkage instead of stamping the whole row.
            fence: bound.fence,
            // Provider observations use the bound child’s execution fence.
            ownerFence: bound.fence
          })
      },
      { ...options, lifecycle: true }
    )

  const publish = (
    options: StructuredAgentSessionPublishOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit(
      {
        bytes: 1,
        publicationKey: options.coalescingKey ?? 'publish',
        run: (bound) => bound.publish()
      },
      options
    )

  const appendItem: NonNullable<StructuredAgentSessionEventSink['tryAppendItem']> = (
    identity,
    body,
    options
  ) =>
    queue.submit(
      {
        bytes: estimateStructuredAgentSessionItemBytes(identity, body, options),
        ...text.hold(estimateStructuredAgentSessionItemBytes(identity, body, options)),
        run: (bound) =>
          bound.journal.appendItem(identity, body, {
            ...structuredAgentSessionJournalAppendOptions(bound.fence, options),
            reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body, options)
          })
      },
      options
    )

  return {
    exitObservation: () => exit,
    sink: {
      observeExit: exit.record,
      appendItem: (identity, body, options) => void appendItem(identity, body, options),
      tryAppendItem: appendItem,
      ...text,
      ...resolvedAppend,
      ...createStructuredAgentSessionTransitionMembers(queue, text.hold),
      journalEpoch: queue.journalEpoch,
      journalLinkage: queue.journalLinkage,
      journalHistory: queue.journalHistory,
      journalStopDecidesTurn: queue.journalStopDecidesTurn,
      appendLifecycleBatch: (settlementId, mutations, options = {}) => {
        const admission = appendLifecycleBatch(settlementId, mutations, options)
        if (!admission.accepted) {
          failed(
            new Error(
              `lifecycle journal batch ${settlementId} rejected by sink ${admission.reason}`
            )
          )
        }
        return admission
      },
      tryAppendLifecycleBatch: appendLifecycleBatch,
      bindReadingControl: (control) => queue.bindReadingControl(control),
      appendTombstone: (identity, options = {}) => {
        queue.submit(
          {
            bytes: Buffer.byteLength(agentJournalItemKey(identity), 'utf8') + 256,
            run: (bound) => bound.journal.appendTombstone(identity, { fence: bound.fence })
          },
          options
        )
      },
      tryAppendTombstone: (identity, options = {}) =>
        queue.submit(
          {
            bytes: Buffer.byteLength(agentJournalItemKey(identity), 'utf8') + 256,
            run: (bound) => bound.journal.appendTombstone(identity, { fence: bound.fence })
          },
          options
        ),
      publish: (options = {}) => void publish(options),
      written: queue.written,
      setActivity: (activity) => {
        queue.submit({
          bytes: Buffer.byteLength(JSON.stringify(activity), 'utf8') + 64,
          publicationKey: 'turn-activity',
          run: (bound) => bound.publish(activity)
        })
      },
      tryPublish: publish
    },
    bind: (next) => queue.bind(next),
    unbind: () => queue.unbind(),
    close: () => queue.close(),
    drained: queue.barrier,
    lifecycleBarrier: queue.barrier,
    state: queue.state
  }
}
