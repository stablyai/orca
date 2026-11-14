import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink
} from './structured-agent-session-event-sink'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import type { JournalTimelineItemResolution } from '../../agent-session-journal/writing/journal-timeline-resolution'
import type { JournalStepOutcome } from '../../agent-session-journal/writing/journal-writer-step'

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
    publish: boolean,
    onOutcome?: (outcome: JournalStepOutcome) => void
  ) => {
    const admission = queue.submit({
      bytes: reservedBytes,
      steps: (bound) => [
        {
          kind: 'resolved-item',
          reservedBytes,
          resolution,
          options: structuredAgentSessionJournalAppendOptions(bound.fence, options)
        }
      ],
      onResolved: (result) => {
        const outcome = result.outcomes[0]
        if (outcome) {
          onOutcome?.(outcome)
        }
      }
    })
    if (admission.accepted && publish) {
      return queue.submit({ bytes: 1, publicationKey: 'publish', run: (bound) => bound.publish() })
    }
    return admission
  }

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
    tryReviseResolvedItem: (reservedBytes, resolution, options, onOutcome) =>
      revise(reservedBytes, resolution, options, false, onOutcome),
    tryReviseResolvedItemAndPublish: (reservedBytes, resolution, options, onOutcome) =>
      revise(reservedBytes, resolution, options, true, onOutcome),
    tryAppendLifecycleTransition: (identitySizeBound, resolution, options) =>
      revise(
        estimateStructuredAgentSessionItemBytes(identitySizeBound, resolution.choice.body),
        resolution,
        options,
        true
      )
  }
}
