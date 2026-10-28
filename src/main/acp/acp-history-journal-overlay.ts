import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId,
  type JournalLifecycleIdentityMutationInput,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'

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
        this.staged.forEach(({ item }) => visit(item.itemId, item.sequence, item.body, item))
    this.journal = {
      epoch,
      item,
      canonicalItemId: (key) => key,
      itemBody: (key) => item(key)?.body ?? null,
      visitItems: visitItemsWithLinkage,
      visitItemsWithLinkage
    }
    this.sink = {
      journalItems: () => this.journal,
      tryAppendTransition: (transition) => {
        for (const step of transition.steps) {
          if (step.kind === 'settlement') {
            step.resolve(this.journal).forEach((mutation) => this.write(mutation))
          } else {
            const resolved = step.resolve(this.journal)
            if (resolved) {
              this.write(
                journalLifecycleItemMutation(step.options, resolved.identity, resolved.body)
              )
            }
          }
        }
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
