import type { JournalTimelineItemResolution } from '../../agent-session-journal/writing/journal-timeline-resolution'
import type {
  JournalStepOutcome,
  JournalStepsResult,
  JournalWriterSettlementResolution,
  JournalWriterStep
} from '../../agent-session-journal/writing/journal-writer-step'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
// Admit each event’s writes whole so producer state cannot advance after partial admission.
// The writer resolves every step in one command; failure retains the written prefix and skips later steps.

export type StructuredAgentSessionTransitionStep =
  | {
      kind: 'item'
      /** Exceeding the reservation fails the sink. */
      reservedBytes: number
      resolution: JournalTimelineItemResolution
      options: StructuredAgentSessionItemAppendOptions
    }
  | {
      kind: 'settlement'
      /** Journal deduplicates settlements by this ID. */
      settlementId: string
      recovered?: true
      /** Queue pacing only; the writer chooses actual mutations. */
      reservedBytes: number
      resolution: JournalWriterSettlementResolution
    }

export type StructuredAgentSessionTransition = {
  steps: readonly StructuredAgentSessionTransitionStep[]
  /** Ending or settling work. */
  lifecycle: boolean
  publish: boolean
  beforeRun?: () => boolean
  onResolved?: (outcomes: readonly JournalStepOutcome[], committed?: JournalStepsResult) => void
  /** Run after writes and parent publication, in queue order. */
  onPublished?: () => void
}

export type StructuredAgentSessionTransitionSink = {
  tryAppendTransition?(
    transition: StructuredAgentSessionTransition
  ): StructuredAgentSessionSinkAdmission
}

export function createStructuredAgentSessionTransitionMembers(
  queue: StructuredAgentSessionSinkQueue
): Required<StructuredAgentSessionTransitionSink> {
  return { tryAppendTransition: transitionAppend(queue) }
}

function transitionAppend(
  queue: StructuredAgentSessionSinkQueue
): (transition: StructuredAgentSessionTransition) => StructuredAgentSessionSinkAdmission {
  return (transition) =>
    queue.submit({
      operations: Math.max(1, transition.steps.length) + (transition.publish ? 1 : 0),
      bytes:
        transition.steps.reduce((total, step) => total + step.reservedBytes, 0) +
        (transition.publish ? 1 : 0),
      run: async (bound) => {
        const { journal, fence } = bound
        const result = await journal.appendSteps(
          transition.steps.map((step): JournalWriterStep =>
            step.kind === 'item'
              ? {
                  kind: 'resolved-item',
                  reservedBytes: step.reservedBytes,
                  resolution: step.resolution,
                  options: structuredAgentSessionJournalAppendOptions(fence, step.options)
                }
              : {
                  kind: 'settlement',
                  settlementId: step.settlementId,
                  reservedBytes: step.reservedBytes,
                  fence,
                  ownerFence: fence,
                  recovered: step.recovered,
                  resolution: step.resolution
                }
          ),
          transition.beforeRun
        )
        transition.onResolved?.(result.outcomes, result)
        if (
          transition.publish &&
          result.outcomes.some((outcome) => outcome.kind === 'committed' && outcome.wrote)
        ) {
          bound.publish()
        }
        if (result.failure) {
          throw restoreJournalSqlFailure(result.failure)
        }
        transition.onPublished?.()
      }
    })
}
