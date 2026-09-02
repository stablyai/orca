import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

export type StructuredAgentSessionJournalBlob = { digest: string; payload: string }

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

export type StructuredAgentSessionAppendOptions = {
  /** Pending checkpoints with this key replace one another before blob writes. */
  coalescingKey?: string
  /** Marks a critical lifecycle operation for lifecycle barriers and diagnostics. */
  lifecycle?: boolean
}

export type StructuredAgentSessionEventSink = {
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    blobs?: readonly StructuredAgentSessionJournalBlob[],
    options?: StructuredAgentSessionAppendOptions
  ): void
  appendTombstone(
    identity: AgentJournalItemIdentity,
    options?: StructuredAgentSessionAppendOptions
  ): void
  tryAppendTombstone?(
    identity: AgentJournalItemIdentity,
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  publish(options?: StructuredAgentSessionAppendOptions): void
  tryAppendItem?(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    blobs?: readonly StructuredAgentSessionJournalBlob[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  appendLifecycleBatch?(
    settlementId: string,
    mutations: readonly JournalLifecycleMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission | void
  tryAppendLifecycleBatch?(
    settlementId: string,
    mutations: readonly JournalLifecycleMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  tryPublish?(options?: StructuredAgentSessionAppendOptions): StructuredAgentSessionSinkAdmission
  /** Couples durable-queue pressure to the exact provider stream producing it. */
  bindReadingControl?(control: StructuredAgentSessionReadingControl): () => void
}

export type StructuredAgentSessionEventTarget = {
  journal: AgentSessionJournal
  fence: number
  publish: () => void
}

export type DeferredStructuredAgentSessionEventSink = {
  sink: StructuredAgentSessionEventSink
  bind(target: StructuredAgentSessionEventTarget): void
  unbind(): void
  close(): void
  drained(): Promise<StructuredAgentSessionSinkBarrier>
  lifecycleBarrier(): Promise<StructuredAgentSessionSinkBarrier>
  state(): StructuredAgentSessionSinkState
}

export type StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: number
  maxQueuedBytes: number
  lowQueuedBytes: number
  pauseQueuedOperations: number
  maxQueuedOperations: number
  lowQueuedOperations: number
  maxLifecycleQueuedBytes: number
  maxLifecycleQueuedOperations: number
}

export type StructuredAgentSessionReadingControl = {
  pauseReading(): void
  resumeReading(): void
}

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

export function createDeferredStructuredAgentSessionEventSink(
  deps: {
    onError?: (error: unknown) => void
    watermarks?: Partial<StructuredAgentSessionSinkWatermarks>
    readingControl?: StructuredAgentSessionReadingControl
    onBackpressureChange?: (backpressured: boolean, state: StructuredAgentSessionSinkState) => void
  } = {}
): DeferredStructuredAgentSessionEventSink {
  const watermarks = { ...DEFAULT_WATERMARKS, ...deps.watermarks }
  const queue = new StructuredAgentSessionSinkQueue({
    watermarks,
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.readingControl ? { readingControl: deps.readingControl } : {}),
    ...(deps.onBackpressureChange ? { onBackpressureChange: deps.onBackpressureChange } : {})
  })

  const appendLifecycleBatch = (
    settlementId: string,
    mutations: readonly JournalLifecycleMutationInput[],
    options: StructuredAgentSessionAppendOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit(
      {
        bytes: Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512,
        coalescingKey: `lifecycle:${settlementId}`,
        run: (bound) =>
          bound.journal.appendLifecycleBatch({
            settlementId,
            mutations,
            fence: bound.fence
          })
      },
      { ...options, lifecycle: true }
    )

  const publish = (
    options: StructuredAgentSessionAppendOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit(
      {
        bytes: 1,
        coalescingKey: options.coalescingKey ?? 'publish',
        run: (bound) => bound.publish()
      },
      options
    )

  return {
    sink: {
      appendItem: (identity, body, blobs = [], options = {}) => {
        queue.submit(
          {
            bytes: estimateStructuredAgentSessionItemBytes(identity, body, blobs),
            coalescingKey: options.coalescingKey,
            run: (bound) =>
              blobs.length > 0 && typeof bound.journal.appendItemWithBlobs === 'function'
                ? bound.journal.appendItemWithBlobs(identity, body, blobs, {
                    fence: bound.fence
                  })
                : bound.journal.appendItem(identity, body, { fence: bound.fence })
          },
          options
        )
      },
      tryAppendItem: (identity, body, blobs = [], options = {}) =>
        queue.submit(
          {
            bytes: estimateStructuredAgentSessionItemBytes(identity, body, blobs),
            coalescingKey: options.coalescingKey,
            run: (bound) =>
              blobs.length > 0 && typeof bound.journal.appendItemWithBlobs === 'function'
                ? bound.journal.appendItemWithBlobs(identity, body, blobs, {
                    fence: bound.fence
                  })
                : bound.journal.appendItem(identity, body, { fence: bound.fence })
          },
          options
        ),
      appendLifecycleBatch: (settlementId, mutations, options = {}) => {
        const admission = appendLifecycleBatch(settlementId, mutations, options)
        if (!admission.accepted) {
          deps.onError?.(
            new Error(
              `lifecycle journal batch ${settlementId} rejected by sink ${admission.reason}`
            )
          )
        }
        return admission
      },
      tryAppendLifecycleBatch: appendLifecycleBatch,
      bindReadingControl: (control) => {
        return queue.bindReadingControl(control)
      },
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
      publish: (options = {}) => {
        publish(options)
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
