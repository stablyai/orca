import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink
} from './structured-agent-session-event-sink'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import type { JournalTimelineItemResolution } from '../../agent-session-journal/writing/journal-timeline-resolution'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'

/** The writer resolves each item at its queue position, seeing prior writes and no later ones. */
export function createStructuredAgentSessionResolvedAppend(
  queue: StructuredAgentSessionSinkQueue
): Required<
  Pick<
    StructuredAgentSessionEventSink,
    | 'tryAppendResolvedItem'
    | 'tryAppendResolvedItemAndPublish'
    | 'tryReviseResolvedItem'
    | 'tryReviseResolvedItemAndPublish'
    | 'tryAppendLifecycleTransition'
  >
> {
  const revise = (
    reservedBytes: number,
    resolution: JournalTimelineItemResolution,
    options: StructuredAgentSessionItemAppendOptions,
    publish: boolean
  ) =>
    queue.submit({
      bytes: reservedBytes + (publish ? 1 : 0),
      run: async (bound) => {
        const result = await bound.journal.appendSteps([
          {
            kind: 'command',
            step: {
              kind: 'resolved-item',
              reservedBytes,
              resolution,
              options: structuredAgentSessionJournalAppendOptions(bound.fence, options)
            }
          }
        ])
        if (result.failure) {
          throw restoreJournalSqlFailure(result.failure)
        }
        const outcome = result.outcomes[0]
        if (publish && outcome?.kind === 'committed' && outcome.wrote) {
          bound.publish()
        }
      }
    })
  const identityOnly =
    (publish: boolean): NonNullable<StructuredAgentSessionEventSink['tryAppendResolvedItem']> =>
    (identitySizeBound, resolution, options) =>
      revise(
        estimateStructuredAgentSessionItemBytes(identitySizeBound, resolution.body),
        resolution,
        options,
        publish
      )
  return {
    tryAppendResolvedItem: identityOnly(false),
    tryAppendResolvedItemAndPublish: identityOnly(true),
    tryReviseResolvedItem: (reservedBytes, resolution, options) =>
      revise(reservedBytes, resolution, options, false),
    tryReviseResolvedItemAndPublish: (reservedBytes, resolution, options) =>
      revise(reservedBytes, resolution, options, true),
    tryAppendLifecycleTransition: (identitySizeBound, resolution, options) =>
      revise(
        estimateStructuredAgentSessionItemBytes(identitySizeBound, resolution.choice.body),
        resolution,
        options,
        true
      )
  }
}
