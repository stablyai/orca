import type { JournalItemEcho } from '../../agent-session-journal/projection/journal-item-echo'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionTurnActivity } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionPublishOptions } from './structured-agent-session-dispatch'
export type { StructuredAgentSessionPublishOptions } from './structured-agent-session-dispatch'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { JournalLifecycleIdentityMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { JournalTimelineItemResolution } from '../../agent-session-journal/writing/journal-timeline-resolution'
import type { JournalStepOutcome } from '../../agent-session-journal/writing/journal-writer-step'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import type { StructuredAgentSessionSnapshotSource } from './structured-agent-session-sink-snapshots'
import type { ClaudeJournalSnapshot } from '../../../claude/subagents/claude-subagent-journaled-identities'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import { createStructuredAgentSessionResolvedAppend } from './structured-agent-session-resolved-append'
import {
  createStructuredAgentSessionTransitionMembers,
  type StructuredAgentSessionTransitionSink
} from './structured-agent-session-transition'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionHistoryJournal } from './structured-agent-session-journal-views'

import * as exits from '../termination/structured-agent-session-exit-observation'

export type StructuredAgentSessionSinkAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' }

export type StructuredAgentSessionSinkState = {
  queuedBytes: number
  queuedOperations: number
  queuedWorkOperations: number
  backpressured: boolean
  failed: boolean
}

export type StructuredAgentSessionSinkBarrier = { ok: true } | { ok: false; error: unknown }

/** Omitted producer linkage means session/root agent. */
export type StructuredAgentSessionAppendOptions = AgentJournalProducerLinkage & {
  lifecycle?: boolean
  observedAt?: number
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
  /** Reads the existing stream owner; no text is copied into the sink. */
  bindLiveText?(source: {
    read(epoch: string): readonly AgentJournalRenderItem[]
    flush(): void
  }): () => void
  publishLiveText?(): StructuredAgentSessionSinkAdmission
  observeExit?: exits.StructuredAgentSessionExitObservation['record']
  /** Adapters report only their acquisition's own spontaneous root exit, never a requested close. */
  observeRootExit?: exits.StructuredAgentSessionRootExitReceipt['observe']
  onRootExit?: exits.StructuredAgentSessionRootExitReceipt['listen']
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
  publishChildWork?: StructuredAgentSessionSinkQueue['publishChildWork']
  /** Not ok if any admitted write failed or close dropped it unwritten. */
  written?(): Promise<StructuredAgentSessionSinkBarrier>
  setActivity?(activity: AgentSessionTurnActivity | null): void
  tryAppendItem?(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  /** The writer chooses the identity at its position; the bound sizes any choice. */
  tryAppendResolvedItem?(
    identitySizeBound: AgentJournalItemIdentity,
    resolution: Extract<JournalTimelineItemResolution, { kind: 'background-task' }>,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  tryAppendResolvedItemAndPublish?(
    identitySizeBound: AgentJournalItemIdentity,
    resolution: Extract<JournalTimelineItemResolution, { kind: 'background-task' }>,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  /** The writer resolves the revision at its position; reserved bytes must bound it. */
  tryReviseResolvedItem?(
    reservedBytes: number,
    resolution: JournalTimelineItemResolution,
    options: StructuredAgentSessionRevisionOptions,
    onOutcome?: (outcome: JournalStepOutcome) => void
  ): StructuredAgentSessionSinkAdmission
  tryReviseResolvedItemAndPublish?(
    reservedBytes: number,
    resolution: JournalTimelineItemResolution,
    options: StructuredAgentSessionRevisionOptions,
    onOutcome?: (outcome: JournalStepOutcome) => void
  ): StructuredAgentSessionSinkAdmission
  /** The writer chooses the row's identity at its position and may write nothing. */
  tryAppendLifecycleTransition?(
    identitySizeBound: AgentJournalItemIdentity,
    resolution: Extract<JournalTimelineItemResolution, { kind: 'thread-goal' }>,
    options: StructuredAgentSessionItemAppendOptions
  ): StructuredAgentSessionSinkAdmission
  journalEpoch?(): string | null
  /** Notices of turns settled by any writer while this sink is bound. */
  observeSettledTurns?(listener: (turnItemIds: readonly string[]) => void): () => void
  /** Saved facts read before translating, replaced whole per epoch. */
  journalSnapshot?(): ClaudeJournalSnapshot | null
  snapshotCurrent?(): Promise<void>
  onJournalBound?(listener: () => void): () => void
  journalHistory?(): StructuredAgentSessionHistoryJournal | null
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
  journal: SqlAgentSessionJournal
  fence: number
  publish: (activity?: AgentSessionTurnActivity | null) => void
  publishLiveText?: (items: readonly AgentJournalRenderItem[]) => void
  /** Turn rows any writer's commit left terminal on this journal. */
  observeSettledTurns?: (listener: (turnItemIds: readonly string[]) => void) => () => void
}

export type DeferredStructuredAgentSessionEventSink = {
  sink: StructuredAgentSessionEventSink
  exitObservation(): Omit<exits.StructuredAgentSessionExitObservation, 'record'>
  bind(target: StructuredAgentSessionEventTarget): void
  unbind(): void
  followSnapshots(source: StructuredAgentSessionSnapshotSource): Promise<void>
  liveText(): readonly AgentJournalRenderItem[]
  seal(): void
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

const DEFAULT_WATERMARKS: StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: 16 * 1024 * 1024,
  lowQueuedBytes: 8 * 1024 * 1024,
  pauseQueuedOperations: 512,
  lowQueuedOperations: 256
}

export function createDeferredStructuredAgentSessionEventSink(deps: {
  sessionId: string
  logger: StructuredAgentSessionLogger
  /** Permanent failure; owner decides whether the provider can continue. */
  onFailed?: (error: unknown) => void
  onWorkChanged?: () => void
  watermarks?: Partial<StructuredAgentSessionSinkWatermarks>
  readingControl?: StructuredAgentSessionReadingControl
  onBackpressureChange?: (backpressured: boolean, state: StructuredAgentSessionSinkState) => void
}): DeferredStructuredAgentSessionEventSink {
  const exit = new exits.StructuredAgentSessionExitObservation()
  const rootExit = new exits.StructuredAgentSessionRootExitReceipt()
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
    ...deps,
    watermarks,
    onFailed: failed
  })
  const resolvedAppend = createStructuredAgentSessionResolvedAppend(queue)

  const appendLifecycleBatch = (
    settlementId: string,
    mutations: readonly JournalLifecycleIdentityMutationInput[]
  ): StructuredAgentSessionSinkAdmission => {
    const reservedBytes =
      Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 1024
    return queue.submit({
      bytes: reservedBytes,
      operations: Math.max(1, mutations.length),
      steps: (bound) => [
        {
          kind: 'lifecycle',
          reservedBytes,
          input: { settlementId, mutations, fence: bound.fence, ownerFence: bound.fence }
        }
      ]
    })
  }

  const publish = (
    options: StructuredAgentSessionPublishOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit({
      bytes: 1,
      publicationKey: options.coalescingKey ?? 'publish',
      run: (bound) => bound.publish()
    })

  const appendItem: NonNullable<StructuredAgentSessionEventSink['tryAppendItem']> = (
    identity,
    body,
    options
  ) => {
    const reservedBytes = estimateStructuredAgentSessionItemBytes(identity, body)
    return queue.submit({
      bytes: reservedBytes,
      steps: (bound) => [
        {
          kind: 'item',
          identity,
          body,
          reservedBytes,
          options: structuredAgentSessionJournalAppendOptions(bound.fence, options)
        }
      ]
    })
  }

  const appendTombstone = (
    identity: AgentJournalItemIdentity
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit({
      bytes: Buffer.byteLength(agentJournalItemKey(identity), 'utf8') + 256,
      run: (bound) => bound.journal.appendTombstone(identity, { fence: bound.fence })
    })

  return {
    exitObservation: () => exit,
    sink: {
      bindLiveText: queue.bindLiveText,
      publishLiveText: queue.publishLiveText,
      observeExit: exit.record,
      observeRootExit: rootExit.observe,
      onRootExit: rootExit.listen,
      appendItem: (identity, body, options) => void appendItem(identity, body, options),
      tryAppendItem: appendItem,
      ...resolvedAppend,
      ...createStructuredAgentSessionTransitionMembers(queue),
      journalEpoch: queue.journalEpoch,
      observeSettledTurns: queue.observeSettledTurns,
      journalSnapshot: queue.journalSnapshot,
      snapshotCurrent: queue.snapshots.settled,
      onJournalBound: queue.onJournalBound,
      journalHistory: queue.journalHistory,
      appendLifecycleBatch: (settlementId, mutations) => {
        const admission = appendLifecycleBatch(settlementId, mutations)
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
      appendTombstone: (identity) => void appendTombstone(identity),
      tryAppendTombstone: appendTombstone,
      publish: (options = {}) => void publish(options),
      publishChildWork: queue.publishChildWork,
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
    followSnapshots: (source) => queue.snapshots.follow(source),
    liveText: queue.liveText,
    seal: () => queue.seal(),
    close: () => {
      queue.flushLiveText()
      queue.close()
    },
    drained: queue.barrier,
    lifecycleBarrier: queue.barrier,
    state: queue.state
  }
}
