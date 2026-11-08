import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId,
  type JournalLifecycleIdentityMutationInput,
  type JournalLifecycleMutationInput
} from '../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import type { ProviderTimelineSink } from '../../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionTransitionJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'
import { resolveJournalTimelineItem } from '../../native-chat/agent-session-journal/writing/journal-timeline-resolution'
import type { JournalStepOutcome } from '../../native-chat/agent-session-journal/writing/journal-writer-step'

/** Pure per-turn scratch: held durable rows never affect replay translation. */
export type AcpHistoryItem = Extract<JournalLifecycleIdentityMutationInput, { kind: 'item' }>

export class AcpHistoryJournalOverlay {
  private readonly staged = new Map<
    string,
    {
      item: AgentJournalRenderItem
      mutation: AcpHistoryItem
    }
  >()
  readonly journal: StructuredAgentSessionTransitionJournal
  readonly sink: ProviderTimelineSink

  constructor(epoch: string) {
    const item = (key: string) => this.staged.get(key)?.item ?? null
    const visitItemsWithLinkage: StructuredAgentSessionTransitionJournal['visitItemsWithLinkage'] =
      (visit) =>
        this.staged.forEach(({ item }) => visit(item.itemId, item.sequence, item.body, item, item))
    this.journal = {
      epoch,
      item,
      canonicalItemId: (key) => key,
      presentationRemoved: () => false,
      itemBody: (key) => item(key)?.body ?? null,
      visitItems: visitItemsWithLinkage,
      visitItemsWithLinkage
    }
    this.sink = {
      journalItems: () => this.journal,
      tryAppendTransition: (transition) => {
        const outcomes: JournalStepOutcome[] = []
        for (const step of transition.steps) {
          if (step.kind === 'settlement') {
            if ('resolution' in step) {
              throw new Error('history catch-up cannot settle a per-turn translation overlay')
            }
            const mutations = step.resolve(this.journal)
            mutations.forEach((mutation) => this.write(mutation))
            outcomes.push({ kind: 'committed', wrote: mutations.length > 0 })
          } else {
            const result =
              'resolution' in step
                ? resolveJournalTimelineItem(item, step.resolution, step.options.turnScope)
                : null
            if (result?.kind === 'dropped') {
              outcomes.push(result)
              continue
            }
            const resolved = 'resolve' in step ? step.resolve(this.journal) : result?.item
            if (resolved) {
              this.write(
                journalLifecycleItemMutation(step.options, resolved.identity, resolved.body)
              )
            }
            outcomes.push(resolved ? { kind: 'committed', wrote: true } : { kind: 'dropped' })
          }
        }
        transition.onResolved?.(outcomes)
        return { accepted: true }
      }
    }
  }

  created(): AcpHistoryItem[] {
    return [...this.staged.values()].map(({ mutation }) => mutation)
  }

  private write(mutation: JournalLifecycleMutationInput): void {
    if (mutation.kind !== 'item') {
      throw new Error('unexpected-history-tombstone')
    }
    const itemId = journalLifecycleMutationItemId(mutation)
    const identity = mutation.identity ?? parseAgentJournalItemKey(itemId)
    if (!identity) {
      throw new Error('unkeyed-history-row')
    }
    const previous = this.staged.get(itemId)
    const turnScope = previous?.item.turnScope ?? mutation.turnScope
    this.staged.set(itemId, {
      item: {
        ...mutation.linkage,
        itemId,
        body: mutation.body,
        turnScope,
        revision: (previous?.item.revision ?? 0) + 1,
        sequence: previous?.item.sequence ?? this.staged.size + 1,
        observedAt: 0
      },
      mutation: {
        ...(previous?.mutation ?? mutation),
        identity,
        itemId: undefined,
        body: mutation.body,
        turnScope,
        ...(mutation.body.kind === 'message' && mutation.body.role === 'user'
          ? { echoOf: null }
          : {})
      }
    })
  }
}
