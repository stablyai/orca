import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal
} from './structured-agent-session-event-sink'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

type ResolvedItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

/** Resolve an item against the journal it lands in, at its own place in that journal's write
 *  queue, so what the resolver reads is every write issued before it and none after. */
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
    queue.submit(
      {
        bytes: reservedBytes,
        ...(input.lifecycle ? { lifecycle: true } : {}),
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
      },
      input.lifecycle ? { lifecycle: true } : options
    )
  const ITEM_OVERFLOW = 'structured agent-session resolved item exceeded its reserved size'
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
    tryReviseResolvedItem: (reservedBytes, resolve, options) =>
      submit(reservedBytes, resolve, options, { publish: false, overflow: ITEM_OVERFLOW }),
    tryReviseResolvedItemAndPublish: (reservedBytes, resolve, options) =>
      submit(reservedBytes + 1, resolve, options, { publish: true, overflow: ITEM_OVERFLOW }),
    tryAppendLifecycleTransition: (identitySizeBound, body, resolveIdentity, options) =>
      submit(
        estimateStructuredAgentSessionItemBytes(identitySizeBound, body),
        (journal) => {
          const identity = resolveIdentity(journal)
          return identity === null ? null : { identity, body }
        },
        options,
        {
          publish: true,
          lifecycle: true,
          overflow: 'structured agent-session item identity exceeded its reserved size'
        }
      )
  }
}
