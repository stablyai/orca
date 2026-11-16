import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId,
  type JournalLifecycleIdentityMutationInput,
  type JournalLifecycleMutationInput
} from '../agent-session-journal/writing/journal-lifecycle-mutation'
import type { ProviderTimelineSink } from './provider-timeline-plan'
import { resolveJournalTimelineItem } from '../agent-session-journal/writing/journal-timeline-resolution'
import { journalTimelineItemsView } from '../agent-session-journal/writing/journal-timeline-view'
import { resolveProviderTimelineSettlement } from './provider-timeline-writer-resolution'
import type { JournalStepOutcome } from '../agent-session-journal/writing/journal-writer-step'

/** Pure per-turn scratch: held durable rows never affect replay translation. */
export type ProviderTimelineHistoryItem = Extract<
  JournalLifecycleIdentityMutationInput,
  { kind: 'item' }
>

export class ProviderTimelineHistoryOverlay {
  private readonly staged = new Map<
    string,
    {
      item: AgentJournalRenderItem
      mutation: ProviderTimelineHistoryItem
    }
  >()
  readonly sink: ProviderTimelineSink

  constructor() {
    const item = (key: string) => this.staged.get(key)?.item ?? null
    const view = journalTimelineItemsView(item, () =>
      [...this.staged.values()].map((staged) => staged.item)
    )
    this.sink = {
      tryAppendTransition: (transition) => {
        const outcomes: JournalStepOutcome[] = []
        for (const step of transition.steps) {
          if (step.kind === 'settlement') {
            if (step.resolution.kind === 'history-catch-up') {
              throw new Error('history catch-up cannot settle a per-turn translation overlay')
            }
            const mutations = resolveProviderTimelineSettlement(view, step.resolution)
            mutations.forEach((mutation) => this.write(mutation))
            outcomes.push({ kind: 'committed', wrote: mutations.length > 0 })
          } else {
            const result = resolveJournalTimelineItem(
              view,
              step.resolution,
              step.options.turnScope,
              step.reservedBytes
            )
            if (result.kind === 'dropped') {
              outcomes.push(result)
              continue
            }
            this.write(
              journalLifecycleItemMutation(
                { ...step.options, turnScope: result.item.turnScope ?? step.options.turnScope },
                result.item.identity,
                result.item.body
              )
            )
            outcomes.push({ kind: 'committed', wrote: true })
          }
        }
        transition.onResolved?.(outcomes)
        return { accepted: true }
      }
    }
  }

  created(): ProviderTimelineHistoryItem[] {
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
