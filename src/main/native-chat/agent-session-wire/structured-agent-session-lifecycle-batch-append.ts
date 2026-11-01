import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

export function createStructuredAgentSessionLifecycleBatchAppend(
  queue: StructuredAgentSessionSinkQueue
): NonNullable<StructuredAgentSessionEventSink['tryAppendLifecycleBatch']> {
  return (settlementId, mutations, options = {}) =>
    queue.submit(
      {
        bytes:
          Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') +
          512 +
          (options.publish ? 1 : 0),
        run: async (bound) => {
          await bound.journal.appendLifecycleBatch({
            settlementId,
            mutations,
            // Per-mutation linkage and the bound child's fence stay with the complete batch.
            fence: bound.fence,
            ownerFence: bound.fence
          })
          if (options.publish) {
            bound.publish()
          }
        }
      },
      { ...options, lifecycle: true }
    )
}
