export type * from './structured-agent-session-event-sink-types'
import type {
  StructuredAgentSessionSinkAdmission,
  StructuredAgentSessionSinkState,
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionPublishOptions,
  StructuredAgentSessionEventSink,
  DeferredStructuredAgentSessionEventSink,
  StructuredAgentSessionSinkWatermarks,
  StructuredAgentSessionReadingControl
} from './structured-agent-session-event-sink-types'

import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

import type { JournalLifecycleIdentityMutationInput } from '../agent-session-journal/journal-row-builders'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import { createStructuredAgentSessionResolvedAppend } from './structured-agent-session-resolved-append'
import { createStructuredAgentSessionTransitionMembers } from './structured-agent-session-transition'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
export type {
  StructuredAgentSessionLifecycleJournal,
  StructuredAgentSessionIdentityResolver,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionHistoryJournal,
  StructuredAgentSessionLinkageJournal,
  StructuredAgentSessionRevisionResolver
} from './structured-agent-session-journal-views'
import { StructuredAgentSessionExitObservation } from './structured-agent-session-exit-observation'

const DEFAULT_WATERMARKS: StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: 16 * 1024 * 1024,
  maxQueuedBytes: 32 * 1024 * 1024,
  lowQueuedBytes: 8 * 1024 * 1024,
  pauseQueuedOperations: 512,
  maxQueuedOperations: 1_024,
  lowQueuedOperations: 256,
  maxLifecycleQueuedBytes: 16 * 1024 * 1024,
  maxLifecycleQueuedOperations: 1_024
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
  const resolvedAppend = createStructuredAgentSessionResolvedAppend(queue)

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
        bytes: estimateStructuredAgentSessionItemBytes(identity, body),
        run: async (bound) => {
          await bound.journal.appendItem(
            identity,
            body,
            structuredAgentSessionJournalAppendOptions(bound.fence, options)
          )
        }
      },
      options
    )

  return {
    exitObservation: () => exit,
    sink: {
      observeExit: exit.record,
      appendItem: (identity, body, options) => void appendItem(identity, body, options),
      tryAppendItem: appendItem,
      ...resolvedAppend,
      ...createStructuredAgentSessionTransitionMembers(queue),
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
