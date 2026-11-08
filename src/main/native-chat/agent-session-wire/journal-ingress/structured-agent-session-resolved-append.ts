import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionRevisionJournal } from './structured-agent-session-journal-views'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import type { JournalTimelineItemResolution } from '../../agent-session-journal/writing/journal-timeline-resolution'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'

type ResolvedItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

/** Resolve at execution in the journal queue, seeing prior writes and no later ones. */
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
  const submit = (
    reservedBytes: number,
    resolve: (journal: StructuredAgentSessionRevisionJournal) => ResolvedItem | null,
    options: StructuredAgentSessionItemAppendOptions,
    input: { publish: boolean; lifecycle?: true; overflow: string }
  ) =>
    queue.submit({
      bytes: reservedBytes,
      run: async (bound) => {
        const landed = await bound.journal.appendResolvedItem(
          () => {
            const resolved = resolve(bound.journal)
            if (
              resolved !== null &&
              estimateStructuredAgentSessionItemBytes(resolved.identity, resolved.body) +
                (input.publish && !input.lifecycle ? 1 : 0) >
                reservedBytes
            ) {
              throw new Error(input.overflow)
            }
            return resolved
          },
          structuredAgentSessionJournalAppendOptions(bound.fence, options)
        )
        if (landed !== null && input.publish) {
          bound.publish()
        }
      }
    })
  const ITEM_OVERFLOW = 'structured agent-session resolved item exceeded its reserved size'
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
  const identityOnly = (publish: boolean) =>
    ((identitySizeBound, body, resolveIdentity, options) =>
      submit(
        estimateStructuredAgentSessionItemBytes(identitySizeBound, body) + (publish ? 1 : 0),
        (journal) => {
          const identity = resolveIdentity(journal)
          return identity === null ? null : { identity, body }
        },
        options,
        { publish, overflow: ITEM_OVERFLOW }
      )) satisfies NonNullable<StructuredAgentSessionEventSink['tryAppendResolvedItem']>
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
