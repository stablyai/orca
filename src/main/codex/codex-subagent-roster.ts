// The Codex subagent roster: one journal row per spawn group, revised in place.
//
// There is no snapshot to read. `agentsStates` arrived empty in the live probe
// and children get no `thread/started`, so the roster is
// accumulated purely from `subAgentActivity` items — each of which arrives TWICE
// (`item/started` and `item/completed`). Every transition here is therefore
// idempotent, and a terminal state latches: duplicate and out-of-order delivery
// must not resurrect a settled child.
//
// KNOWN LIMITATION: `groups` is process-local and is never seeded from the
// journal, while the row's identity is keyed on the group id alone. So once a
// group leaves the map its row stays, and the next activity item rebuilds that
// row from one child — rewriting N down to one. Two ways in: eviction past
// MAX_CODEX_SUBAGENT_GROUPS, which drops the oldest-inserted group in-process
// even while it is live, and skips the sweep so its children never latch
// `unverifiable`; and a restart on `threadId:outside-turn`, the one group id
// that outlives the process — `thread/resume` is verified to return the same
// thread, and a real turn id is assumed freshly minted per turn. Seeding from
// the journal is the fix.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import {
  canReplaceSubagentState,
  isTerminalSubagentState,
  MAX_SUBAGENT_FIELD_CHARS,
  subagentGroupFallbackText
} from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  codexSubagentLabel,
  codexSubagentStateForKind,
  isCodexRootAgentActivity,
  readCodexSubagentActivity,
  readCodexThreadTokenTotal
} from './codex-subagent-activity'
import type { CodexThreadItem } from './codex-structured-item-translation'
import {
  MAX_CODEX_SUBAGENT_GROUPS,
  MAX_CODEX_SUBAGENTS_PER_GROUP,
  MAX_CODEX_TOKEN_USAGE_THREADS
} from './codex-structured-journal-limits'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/** The turn a group belongs to when Codex reports activity outside any turn.
 *  Mirrors the generic-frame bucket name so the two read alike in the journal. */
const OUTSIDE_TURN = 'outside-turn'

const UNLABELLED_AGENT = 'subagent'

type RosterGroup = {
  groupId: string
  identity: AgentJournalItemIdentity
  /** Insertion order is the display order; the map holds the state. */
  entries: Map<string, NativeChatSubagentEntry>
  /** Times each label has been claimed, so a repeat gets an ordinal suffix. */
  labelCounts: Map<string, number>
  /** Last body written, so an idempotent replay writes no new revision. */
  lastSerialized: string | null
}

/** Group identity: the parent turn that spawned the children. `agentPath` is a
 *  tree rooted at the parent thread, so every child of one turn shares a row
 *  no matter which thread's stream carried its activity item. */
export function codexSubagentGroupId(threadId: string, turnId: string | null): string {
  return `${threadId}:${turnId ?? OUTSIDE_TURN}`
}

/** Durable journal identity for the group's row — stable across revisions and
 *  across a restart, so replay finds the same row instead of appending a new one. */
export function codexSubagentGroupIdentity(groupId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `codex-subagents:${groupId}` }
}

export type CodexSubagentRosterDeps = {
  sink: StructuredAgentSessionEventSink
  /** The thread that owns the agent tree; falls back to the event's thread. */
  primaryThreadId: () => string | null
  activeTurn: (threadId: string) => string | null
  now?: () => number
}

export class CodexSubagentRoster {
  private readonly groups = new Map<string, RosterGroup>()
  /** Latest reported total per thread, kept regardless of roster membership: a
   *  usage frame can arrive before the child's first activity item, and filtering
   *  at receipt would lose it permanently. Children are selected at write time;
   *  the map itself is LRU-capped in `handleTokenUsage`. */
  private readonly tokensByThread = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: CodexSubagentRosterDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Consume a `subAgentActivity` item. Returns null when the item is not one. */
  handleItem(input: {
    threadId: string
    turnId: string | null
    item: CodexThreadItem
  }): StructuredAgentSessionSinkAdmission | null {
    const activity = readCodexSubagentActivity(input.item)
    if (!activity) {
      return null
    }
    // The root node is the parent turn itself, not a child it spawned.
    if (isCodexRootAgentActivity(activity)) {
      return ADMITTED
    }
    const group = this.groupFor(input.threadId, input.turnId)
    const existing = group.entries.get(activity.agentThreadId)
    const state = codexSubagentStateForKind(activity.kind)
    if (!existing) {
      // Rule: the first event for a child may be ANY kind. An `interacted` or
      // `completed` with no prior `started` creates the entry in the state its
      // kind implies rather than being dropped for lacking a roster row.
      if (group.entries.size >= MAX_CODEX_SUBAGENTS_PER_GROUP) {
        return ADMITTED
      }
      const now = this.now()
      group.entries.set(activity.agentThreadId, {
        id: activity.agentThreadId,
        label: this.claimLabel(group, codexSubagentLabel(activity)),
        state,
        startedAt: now,
        ...(isTerminalSubagentState(state) ? { settledAt: now } : {})
      })
    } else if (canReplaceSubagentState(existing.state, state)) {
      // A child's own verdict latches. Re-applying the same non-terminal state
      // is a no-op, which is what makes the duplicate `item/started` +
      // `item/completed` delivery idempotent. `unverifiable` does not latch: a
      // child swept when contact was lost can still report what it actually did
      // if contact returns.
      group.entries.set(activity.agentThreadId, {
        ...existing,
        state,
        ...(isTerminalSubagentState(state) ? { settledAt: this.now() } : {})
      })
    }
    return this.write(group)
  }

  /** Consume `thread/tokenUsage/updated`. Returns null when the params are not one. */
  handleTokenUsage(params: unknown): StructuredAgentSessionSinkAdmission | null {
    const usage = readCodexThreadTokenTotal(params)
    if (!usage) {
      return null
    }
    // A running total: the newest frame REPLACES the previous one. Summing
    // updates would multiply a single child's usage by its frame count.
    // Re-insert so the eviction scan below sees recency: `set` on an existing
    // key keeps its original position, which would age out an active thread.
    this.tokensByThread.delete(usage.threadId)
    this.tokensByThread.set(usage.threadId, usage.totalTokens)
    while (this.tokensByThread.size > MAX_CODEX_TOKEN_USAGE_THREADS) {
      const oldest = this.tokensByThread.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.tokensByThread.delete(oldest)
    }
    for (const group of this.groups.values()) {
      if (!group.entries.has(usage.threadId)) {
        continue
      }
      const admission = this.write(group)
      if (!admission.accepted) {
        return admission
      }
    }
    return ADMITTED
  }

  /**
   * The provider is gone, so any child still reported as working will never be
   * settled by an event: it becomes `unverifiable` — contact was lost, which is
   * NOT evidence the child exited.
   *
   * This is the ONLY sweep. A turn ending is not one: `spawn_agent` children
   * routinely outlive their turn and keep reporting into the same group.
   */
  settleSession(): StructuredAgentSessionSinkAdmission {
    for (const group of this.groups.values()) {
      const admission = this.sweep(group)
      if (!admission.accepted) {
        return admission
      }
    }
    return ADMITTED
  }

  dispose(): void {
    this.groups.clear()
    this.tokensByThread.clear()
  }

  private sweep(group: RosterGroup | undefined): StructuredAgentSessionSinkAdmission {
    if (!group) {
      return ADMITTED
    }
    let changed = false
    for (const [id, entry] of group.entries) {
      if (isTerminalSubagentState(entry.state)) {
        continue
      }
      group.entries.set(id, { ...entry, state: 'unverifiable', settledAt: this.now() })
      changed = true
    }
    // A null `lastSerialized` means the previous write was refused part-way, so
    // the settled roster's last revision is queued but never published. Nothing
    // is guaranteed to write this group again, so retry here even when the sweep
    // itself changed nothing.
    return changed || group.lastSerialized === null ? this.write(group) : ADMITTED
  }

  private groupFor(threadId: string, turnId: string | null): RosterGroup {
    const ownerThreadId = this.deps.primaryThreadId() ?? threadId
    const ownerTurnId =
      ownerThreadId === threadId ? turnId : (this.deps.activeTurn(ownerThreadId) ?? turnId)
    const groupId = codexSubagentGroupId(ownerThreadId, ownerTurnId)
    const existing = this.groups.get(groupId)
    if (existing) {
      return existing
    }
    const group: RosterGroup = {
      groupId,
      identity: codexSubagentGroupIdentity(groupId),
      entries: new Map(),
      labelCounts: new Map(),
      lastSerialized: null
    }
    this.groups.set(groupId, group)
    while (this.groups.size > MAX_CODEX_SUBAGENT_GROUPS) {
      const oldest = this.groups.keys().next().value
      if (typeof oldest !== 'string' || oldest === groupId) {
        break
      }
      this.groups.delete(oldest)
    }
    return group
  }

  /** Two children can share a trailing path segment; the ordinal keeps their
   *  rows apart without inventing a name the provider never sent. */
  private claimLabel(group: RosterGroup, label: string | null): string {
    const base = label ?? UNLABELLED_AGENT
    const seen = group.labelCounts.get(base) ?? 0
    group.labelCounts.set(base, seen + 1)
    return seen === 0 ? base : `${base} ${seen + 1}`
  }

  private write(group: RosterGroup): StructuredAgentSessionSinkAdmission {
    const agents = [...group.entries].map(([id, entry]) => {
      const tokens = this.tokensByThread.get(id)
      if (typeof tokens !== 'number' || tokens === entry.tokens) {
        return entry
      }
      // Persisted, not merely read: the thread map is LRU-capped, and reading it
      // afresh each write would retract a count this row has already shown.
      const merged = { ...entry, tokens }
      group.entries.set(id, merged)
      return merged
    })
    const body = codexSubagentGroupBody(group.groupId, agents)
    const serialized = JSON.stringify(body)
    if (serialized === group.lastSerialized) {
      // Nothing changed — a duplicate delivery must not burn a revision.
      return ADMITTED
    }
    group.lastSerialized = serialized
    // The append coalesces per group so a burst collapses to the latest roster.
    // The publish must NOT reuse that key: the queue coalesces by key alone,
    // with no op-kind check, so a publish carrying it would splice out the
    // still-queued append and the row would never reach the journal.
    const options = { coalescingKey: `codex-subagents:${group.groupId}` }
    const admission = this.deps.sink.tryAppendItem
      ? this.deps.sink.tryAppendItem(group.identity, body, options)
      : (this.deps.sink.appendItem(group.identity, body, options), ADMITTED)
    if (!admission.accepted) {
      group.lastSerialized = null
      return admission
    }
    const published = this.deps.sink.tryPublish
      ? this.deps.sink.tryPublish()
      : (this.deps.sink.publish(), ADMITTED)
    if (!published.accepted) {
      // Symmetric with the append refusal above: the suppression state may only
      // advance once the revision is both queued AND published. Left set, an
      // identical replay short-circuits and the last revision of a settled
      // roster stays queued but never reaches the renderer.
      group.lastSerialized = null
    }
    return published
  }
}

/** The roster row: the structured block plus the plain sentence an older client
 *  renders in its place. A message whose only block is the new variant would
 *  reach such a client with nothing it can draw. */
export function codexSubagentGroupBody(
  groupId: string,
  agents: readonly NativeChatSubagentEntry[]
): AgentJournalItemBody {
  const bounded = agents.map((agent, index) => ({
    ...agent,
    id: boundSubagentField(agent.id, index),
    label: boundSubagentField(agent.label, index)
  }))
  return {
    kind: 'message',
    role: 'system',
    blocks: [
      { type: 'text', text: subagentGroupFallbackText(bounded) },
      { type: 'subagent-group', groupId, agents: bounded }
    ]
  }
}

/** `id` and `label` are provider strings, so they take the bound both readers of
 *  this row already clip them to. A plain length check, not the tool-output
 *  bound: that one digests the whole value before it checks the length, and this
 *  runs twice per child on every streamed token-usage frame.
 *
 *  A clip is not identity-preserving, so a clipped value carries the child's
 *  index: two ids sharing a long prefix collapse to one React key, and
 *  `claimLabel` writes its ordinal at the very tail the clip removes. The index
 *  is reserved out of the bound, not appended to it, because both readers
 *  re-clip to the same cap and would cut a suffix that overflowed it. */
function boundSubagentField(value: string, index: number): string {
  if (value.length <= MAX_SUBAGENT_FIELD_CHARS) {
    return value
  }
  const suffix = `…~${index}`
  const keep = MAX_SUBAGENT_FIELD_CHARS - suffix.length
  // Slicing UTF-16 units can split a surrogate pair; a lone surrogate is
  // malformed in a durable row and lossy through any non-JSON UTF-8 hop.
  const last = value.charCodeAt(keep - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  return `${value.slice(0, end)}${suffix}`
}
