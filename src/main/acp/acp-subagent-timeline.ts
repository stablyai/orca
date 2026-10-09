import {
  canReplaceSubagentState,
  isTerminalSubagentState
} from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  boundSubagentField,
  subagentGroupJournalBody
} from '../native-chat/agent-session-journal/journal-subagent-group-body'
import type { ProviderTimelineJoin } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { acpSubagentIdentity, type AcpTimelineEvent } from './acp-timeline-event'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'
import { SubagentRosterRetention } from '../native-chat/subagent-roster-retention'

/** Settled history budget; live ownership outlives it until an outcome or session close. */
const MAX_GROUPS = 32
const MAX_SUBAGENTS_PER_GROUP = 64
const UNLABELLED = 'subagent'

type RosterGroup = {
  groupId: string
  turn?: string
  entries: Map<string, NativeChatSubagentEntry>
  labelCounts: Map<string, number>
  lastSerialized: string | null
  results: Map<string, string>
}

/** One roster row per spawning turn, revised in place, plus each completed subagent's reply as its
 *  own row, filed under its id so it opens beneath its roster entry. Lives as long as the provider
 *  child: a subagent an earlier run spawned is not known here, and its row is that run's. */
export class AcpSubagentTimeline {
  private readonly groups = new Map<string, RosterGroup>()
  private readonly groupOf = new Map<string, string>()
  private readonly retention = new SubagentRosterRetention(this.groups, {
    maxGroups: MAX_GROUPS,
    maxSettledIdentities: MAX_GROUPS * MAX_SUBAGENTS_PER_GROUP,
    entries: (group) => group.entries.values(),
    identities: (group) => group.entries.keys(),
    onEvict: (group) => {
      for (const id of group.entries.keys()) {
        this.groupOf.delete(id)
      }
    }
  })
  private disposed = false

  /** Known children include recently evicted outcomes, so they cannot become background tasks. */
  has(id: string): boolean {
    return this.groupOf.has(id) || this.retention.hasSettled(id)
  }

  /** The journal owns session-end settlement; no later frame may reacquire working ownership. */
  dispose(): void {
    this.disposed = true
    this.groups.clear()
    this.groupOf.clear()
    this.retention.clear()
  }

  translate(
    updates: AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): AcpTimelineEvent[] {
    if (this.disposed) {
      return []
    }
    const changed = new Set<RosterGroup>()
    const replies: { id: string; group: RosterGroup; text: string }[] = []
    for (const update of updates) {
      const group = this.apply(update, join, at)
      if (!group) {
        continue
      }
      changed.add(group)
      const entry = group.entries.get(update.id)
      if (update.result && entry?.state === 'completed') {
        replies.push({ id: update.id, group, text: update.result })
      }
    }
    const events = [...changed].flatMap((group) => this.groupEvent(group, join))
    for (const { id, group, text } of replies) {
      const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      if (group.results.get(id) === bounded) {
        continue
      }
      group.results.set(id, bounded)
      events.push({
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: bounded }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: groupJoin(group, join)
      })
    }
    // Emit the final roster and reply before releasing their cached ownership together.
    this.retention.trim(changed)
    return events
  }

  private apply(
    update: AcpSubagentUpdate,
    join: ProviderTimelineJoin,
    at: number
  ): RosterGroup | undefined {
    if (this.retention.hasSettled(update.id)) {
      return undefined
    }
    const known = this.groups.get(this.groupOf.get(update.id) ?? '')
    const current = known?.entries.get(update.id)
    if (known && current) {
      const state =
        update.state && canReplaceSubagentState(current.state, update.state)
          ? update.state
          : current.state
      known.entries.set(update.id, {
        ...current,
        state,
        ...(state !== current.state && isTerminalSubagentState(state) ? { settledAt: at } : {}),
        ...(update.tokens ? { tokens: update.tokens } : {})
      })
      return known
    }
    if (update.knownOnly) {
      return undefined
    }
    const group = this.groupFor(update.turn ?? join.turn)
    if (group.entries.size >= MAX_SUBAGENTS_PER_GROUP) {
      return undefined
    }
    const state = update.state ?? 'working'
    group.entries.set(update.id, {
      id: update.id,
      label: this.claimLabel(group, update.label ?? UNLABELLED),
      state,
      startedAt: at,
      ...(isTerminalSubagentState(state) ? { settledAt: at } : {}),
      ...(update.tokens ? { tokens: update.tokens } : {})
    })
    this.groupOf.set(update.id, group.groupId)
    return group
  }

  private groupFor(turn: string | undefined): RosterGroup {
    const groupId = turn ?? 'thread'
    const existing = this.groups.get(groupId)
    if (existing) {
      return existing
    }
    const group: RosterGroup = {
      groupId,
      ...(turn === undefined ? {} : { turn }),
      entries: new Map(),
      labelCounts: new Map(),
      lastSerialized: null,
      results: new Map()
    }
    this.groups.set(groupId, group)
    return group
  }

  /** Two subagents with one description stay apart by ordinal, not by an invented name. */
  private claimLabel(group: RosterGroup, label: string): string {
    const index = group.entries.size
    const clipped = boundSubagentField(label, index)
    // Copy clipped text so a slice cannot keep the full provider description alive.
    const bounded = clipped === label ? label : [...clipped].join('')
    const seen = group.labelCounts.get(bounded) ?? 0
    group.labelCounts.set(bounded, seen + 1)
    return boundSubagentField(seen === 0 ? bounded : `${bounded} ${seen + 1}`, index)
  }

  private groupEvent(group: RosterGroup, join: ProviderTimelineJoin): AcpTimelineEvent[] {
    const entries = [...group.entries.values()]
    const body = subagentGroupJournalBody(group.groupId, entries)
    const serialized = JSON.stringify(body)
    if (serialized === group.lastSerialized) {
      return []
    }
    // A repeated report must not burn a revision; the host retries a refused event itself.
    group.lastSerialized = serialized
    return [
      {
        type: 'item.update',
        item: `subagents:${group.groupId}`,
        body,
        subagentIdentities: entries.map((entry) => acpSubagentIdentity(entry.id)),
        join: groupJoin(group, join)
      }
    ]
  }
}

function groupJoin(group: RosterGroup, join: ProviderTimelineJoin): ProviderTimelineJoin {
  return {
    ...(join.thread === undefined ? {} : { thread: join.thread }),
    ...(group.turn ? { turn: group.turn } : {})
  }
}
