import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

/** Resolve a queued item's run identity against the journal bound at execution. */
export function createStructuredAgentSessionResolvedAppend(
  queue: StructuredAgentSessionSinkQueue
): {
  tryAppendResolvedItem: NonNullable<StructuredAgentSessionEventSink['tryAppendResolvedItem']>
  tryAppendResolvedItemAndPublish: NonNullable<
    StructuredAgentSessionEventSink['tryAppendResolvedItemAndPublish']
  >
} {
  return {
    tryAppendResolvedItem: (identitySizeBound, body, resolveIdentity, options = {}) => {
      const bytes = estimateStructuredAgentSessionItemBytes(identitySizeBound, body)
      return queue.submit(
        {
          bytes,
          run: async (bound) => {
            const identity = resolveIdentity(bound.journal)
            if (identity === null) {
              return
            }
            if (estimateStructuredAgentSessionItemBytes(identity, body) > bytes) {
              throw new Error('structured agent-session item identity exceeded its reserved size')
            }
            await bound.journal.appendItem(
              identity,
              body,
              structuredAgentSessionJournalAppendOptions(bound.fence, options)
            )
          }
        },
        options
      )
    },
    tryAppendResolvedItemAndPublish: (identitySizeBound, body, resolveIdentity, options = {}) => {
      const bytes = estimateStructuredAgentSessionItemBytes(identitySizeBound, body) + 1
      return queue.submit(
        {
          bytes,
          run: async (bound) => {
            const identity = resolveIdentity(bound.journal)
            if (identity === null) {
              return
            }
            if (estimateStructuredAgentSessionItemBytes(identity, body) + 1 > bytes) {
              throw new Error('structured agent-session item identity exceeded its reserved size')
            }
            await bound.journal.appendItem(
              identity,
              body,
              structuredAgentSessionJournalAppendOptions(bound.fence, options)
            )
            bound.publish()
          }
        },
        options
      )
    }
  }
}
