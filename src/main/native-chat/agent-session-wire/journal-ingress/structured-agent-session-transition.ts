import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLifecycleMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalStep } from '../../agent-session-journal/writing/journal-step-writer'
import type {
  JournalHistoryResolution,
  JournalStepOutcome
} from '../../agent-session-journal/writing/journal-writer-step'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
// Admit each event’s writes whole so producer state cannot advance after partial admission.
// Execute against the latest fold in one queue turn; failure retains the written prefix and skips later steps.

export type StructuredAgentSessionTransitionJournal = Pick<
  AgentSessionJournal,
  | 'epoch'
  | 'visitItems'
  | 'itemBody'
  | 'item'
  | 'visitItemsWithLinkage'
  | 'canonicalItemId'
  | 'presentationRemoved'
>

export type StructuredAgentSessionTransitionStep =
  | {
      kind: 'item'
      /** Exceeding the reservation fails the sink. */
      reservedBytes: number
      resolve: (journal: StructuredAgentSessionTransitionJournal) => {
        identity: AgentJournalItemIdentity
        body: AgentJournalItemBody
      } | null
      options: StructuredAgentSessionItemAppendOptions
    }
  | {
      kind: 'settlement'
      /** Journal deduplicates settlements by this ID. */
      settlementId: string
      recovered?: true
      /** Queue pacing only; the journal chooses actual mutations. */
      reservedBytes: number
      /** Resolve at execution; an empty result writes nothing. */
      resolve: (
        journal: StructuredAgentSessionTransitionJournal
      ) => readonly JournalLifecycleMutationInput[]
    }
  | {
      kind: 'settlement'
      settlementId: string
      recovered?: true
      reservedBytes: number
      resolution: JournalHistoryResolution
    }

export type StructuredAgentSessionTransition = {
  steps: readonly StructuredAgentSessionTransitionStep[]
  /** Ending or settling work. */
  lifecycle: boolean
  publish: boolean
  beforeRun?: () => boolean
  onResolved?: (outcomes: readonly JournalStepOutcome[]) => void
  /** Run after writes and parent publication, in queue order. */
  onPublished?: () => void
}

const STEP_OVERFLOW = 'structured agent-session transition step exceeded its reserved size'

export type StructuredAgentSessionTransitionSink = {
  tryAppendTransition?(
    transition: StructuredAgentSessionTransition
  ): StructuredAgentSessionSinkAdmission
  /** null until the sink binds to a journal. */
  journalItems?(): StructuredAgentSessionTransitionJournal | null
}

export function createStructuredAgentSessionTransitionMembers(
  queue: StructuredAgentSessionSinkQueue
): Required<StructuredAgentSessionTransitionSink> {
  return { tryAppendTransition: transitionAppend(queue), journalItems: queue.journalItems }
}

function transitionAppend(
  queue: StructuredAgentSessionSinkQueue
): (transition: StructuredAgentSessionTransition) => StructuredAgentSessionSinkAdmission {
  return (transition) =>
    queue.submit({
      bytes:
        transition.steps.reduce((total, step) => total + step.reservedBytes, 0) +
        (transition.publish ? 1 : 0),
      run: async (bound) => {
        const { journal, fence } = bound
        const result = await journal.appendSteps(
          transition.steps.map((step): JournalStep =>
            step.kind === 'item'
              ? {
                  kind: 'item',
                  resolve: () => {
                    const resolved = step.resolve(journal)
                    if (
                      resolved &&
                      estimateStructuredAgentSessionItemBytes(resolved.identity, resolved.body) >
                        step.reservedBytes
                    ) {
                      throw new Error(STEP_OVERFLOW)
                    }
                    return resolved
                  },
                  options: structuredAgentSessionJournalAppendOptions(fence, step.options)
                }
              : 'resolution' in step
                ? {
                    kind: 'command',
                    step: {
                      kind: 'settlement',
                      settlementId: step.settlementId,
                      reservedBytes: step.reservedBytes,
                      fence,
                      ownerFence: fence,
                      recovered: step.recovered,
                      resolution: step.resolution
                    }
                  }
                : {
                    kind: 'settlement',
                    batch: {
                      settlementId: step.settlementId,
                      fence,
                      ownerFence: fence,
                      recovered: step.recovered,
                      resolve: () => step.resolve(journal)
                    }
                  }
          ),
          transition.beforeRun
        )
        transition.onResolved?.(result.outcomes)
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
