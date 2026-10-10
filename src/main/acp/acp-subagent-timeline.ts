import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ProviderTimelineJoin } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { SubagentTracker } from '../native-chat/subagent-tracker/subagent-tracker'
import type { SubagentGroup } from '../native-chat/subagent-tracker/subagent-tracker-types'
import { acpSubagentIdentity, type AcpTimelineEvent } from './acp-timeline-event'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'

/** The group a subagent reported outside any turn belongs to. */
const OUTSIDE_TURN = 'thread'

/** One roster row per spawning turn, revised in place, plus each completed subagent's reply as its
 *  own row, filed under its id so it opens beneath its roster entry. The rows follow the shared
 *  subagent tracker's rules; this module only reads the dialect's updates. Lives as long as the
 *  provider child: a subagent an earlier run spawned is not known here, and its row is that run's. */
export class AcpSubagentTimeline {
  /** Row events the tracker wrote during the current `translate`. */
  private written: AcpTimelineEvent[] = []
  private readonly results = new Map<string, string>()
  /** The time of the updates being translated: when they were observed. */
  private at = 0
  private readonly tracker = new SubagentTracker<ProviderTimelineJoin>({
    // The host admits the events later and retries a refused one itself.
    port: {
      write: (group, { body }) => {
        if (body) {
          this.written.push({
            type: 'item.update',
            item: `subagents:${group.groupId}`,
            body,
            subagentIdentities: [...group.entries.keys()].map(acpSubagentIdentity),
            join: group.placement
          })
        }
        return { accepted: true }
      }
    },
    now: () => this.at,
    onEvict: (group) => {
      for (const id of group.entries.keys()) {
        this.results.delete(id)
      }
    }
  })
  private disposed = false

  /** Known children include recently evicted outcomes, so they cannot become background tasks. */
  has(id: string): boolean {
    return this.tracker.has(id)
  }

  /** Retention is not observable through the update API, so expose what it holds. */
  retentionSizes(): { groups: number; settledIdentities: number; replies: number } {
    return { ...this.tracker.sizes(), replies: this.results.size }
  }

  /** No later frame may reacquire working ownership. */
  dispose(): void {
    this.disposed = true
    this.tracker.dispose()
    this.results.clear()
    this.written = []
  }

  /** The provider session is gone: every child it still ran loses contact at this moment. */
  settleSession(at: number): AcpTimelineEvent[] {
    if (this.disposed) {
      return []
    }
    this.at = at
    this.written = []
    this.tracker.batch(() => this.tracker.settleSession())
    const events = this.written
    this.written = []
    return events
  }

  translate(
    updates: AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): AcpTimelineEvent[] {
    if (this.disposed) {
      return []
    }
    const replies: AcpTimelineEvent[] = []
    this.written = []
    // One revision per changed row; replies are cached before the batch releases settled rows, so a
    // released row's replies go with it.
    this.tracker.batch(() => {
      for (const update of updates) {
        this.apply(update, join, at)
        const located = this.tracker.locate(update.id)
        if (update.result && located?.tracked.entry.state === 'completed') {
          replies.push(...this.reply(update.id, located.group, update.result))
        }
      }
    })
    const events = [...this.written, ...replies]
    this.written = []
    return events
  }

  private reply(
    id: string,
    group: SubagentGroup<ProviderTimelineJoin>,
    text: string
  ): AcpTimelineEvent[] {
    const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    if (this.results.get(id) === bounded) {
      return []
    }
    this.results.set(id, bounded)
    return [
      {
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: bounded }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: group.placement
      }
    ]
  }

  private apply(update: AcpSubagentUpdate, join: ProviderTimelineJoin, at: number): void {
    const turn = update.turn ?? join.turn
    const placement: ProviderTimelineJoin = {
      ...(join.thread === undefined ? {} : { thread: join.thread }),
      ...(turn === undefined ? {} : { turn })
    }
    this.at = at
    this.tracker.report({
      id: update.id,
      group: { id: turn ?? OUTSIDE_TURN, placement: () => placement },
      announces: update.knownOnly !== true,
      ...(update.label !== undefined ? { label: update.label } : {}),
      ...(update.state !== undefined ? { state: update.state } : {}),
      ...(update.tokens !== undefined ? { tokens: update.tokens } : {}),
      // A subagent the provider runs outlives the prompt turn that spawned it.
      backgrounded: true
    })
  }
}
