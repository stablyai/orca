// The Codex subagent roster: one journal row per spawn group, revised in place.
//
// Activity supplies membership; child turn events supply execution state.
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

import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentState
} from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  codexSubagentLabel,
  isCodexRootAgentActivity,
  readCodexSubagentActivity,
  readCodexThreadTokenTotal
} from './codex-subagent-activity'
import {
  CodexSubagentExecutions,
  codexChildTurnState,
  type CodexChildExecution,
  type CodexExecutionChild
} from './codex-subagent-executions'
import { readRecord } from './codex-item-field-readers'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { codexSubagentGroupBody } from './codex-subagent-group-body'
export { codexSubagentGroupBody } from './codex-subagent-group-body'
import type { CodexThreadItem } from './codex-structured-item-translation'
import {
  MAX_CODEX_SUBAGENT_GROUPS,
  MAX_CODEX_SUBAGENTS_PER_GROUP,
  MAX_CODEX_TOKEN_USAGE_THREADS
} from './codex-structured-journal-limits'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

/** The turn a group belongs to when Codex reports activity outside any turn.
 *  Mirrors the generic-frame bucket name so the two read alike in the journal. */
type RosterGroup = {
  groupId: string
  identity: AgentJournalItemIdentity
  /** Insertion order is the display order; the map holds the state. */
  entries: Map<string, NativeChatSubagentEntry>
  executionTurns: Map<string, string | null>
  /** Times each label has been claimed, so a repeat gets an ordinal suffix. */
  labelCounts: Map<string, number>
  /** Last body written, so an idempotent replay writes no new revision. */
  lastSerialized: string | null
}

/** Group identity: the parent turn that spawned the children. `agentPath` is a
 *  tree rooted at the parent thread, so every child of one turn shares a row
 *  no matter which thread's stream carried its activity item. */
export function codexSubagentGroupId(threadId: string, turnId: string | null): string {
  return `${threadId}:${turnId ?? 'outside-turn'}`
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
  executions?: CodexSubagentExecutions
}

export class CodexSubagentRoster {
  private readonly groups = new Map<string, RosterGroup>()
  /** Latest reported total per thread, kept regardless of roster membership: a
   *  usage frame can arrive before the child's first activity item, and filtering
   *  at receipt would lose it permanently. Children are selected at write time;
   *  the map itself is LRU-capped in `handleTokenUsage`. */
  private readonly tokensByThread = new Map<string, number>()
  private readonly now: () => number
  private readonly executions: CodexSubagentExecutions

  constructor(private readonly deps: CodexSubagentRosterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.executions = deps.executions ?? new CodexSubagentExecutions()
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
    if (
      activity.agentThreadId === this.deps.primaryThreadId() ||
      isCodexRootAgentActivity(activity)
    ) {
      return ADMITTED
    }
    const child = this.executions.register(
      activity.agentThreadId,
      codexSubagentLabel(activity),
      activity.kind === 'started' || activity.kind === 'interacted' ? input.turnId : undefined
    )
    if (!child?.execution) {
      return ADMITTED
    }
    const group =
      this.executionGroup(child.agentThreadId, child.execution.turnId) ??
      this.groupFor(input.threadId, input.turnId)
    if (!group.entries.has(child.agentThreadId)) {
      this.recordExecution(group, child, child.execution)
    }
    return this.write(group)
  }

  handleTurnEvent(event: {
    method: string
    threadId: string
    params: unknown
  }): StructuredAgentSessionSinkAdmission {
    const turnId = readCodexTurnId(event.params)
    return turnId
      ? this.handleTurn({
          threadId: event.threadId,
          turnId,
          state:
            event.method === 'turn/started'
              ? 'working'
              : codexChildTurnState(readRecord(readRecord(event.params).turn).status)
        })
      : ADMITTED
  }

  handleTurn(input: {
    threadId: string
    turnId: string
    state: NativeChatSubagentState
  }): StructuredAgentSessionSinkAdmission {
    if (input.threadId === this.deps.primaryThreadId()) {
      return ADMITTED
    }
    const observed = this.executions.observeTurn(input.threadId, input.turnId, input.state)
    if (!observed || !observed.child.registered) {
      return ADMITTED
    }
    const { child, execution } = observed
    if (input.state === 'working') {
      const parent = this.deps.primaryThreadId() ?? input.threadId
      const group =
        this.executionGroup(child.agentThreadId, execution.turnId) ??
        this.groupFor(parent, this.deps.activeTurn(parent) ?? child.parentTurnId)
      this.recordExecution(group, child, execution)
      return this.write(group)
    }
    for (const group of this.groups.values()) {
      if (group.executionTurns.get(input.threadId) !== input.turnId) {
        continue
      }
      this.recordExecution(group, child, execution)
      const admission = this.write(group)
      if (!admission.accepted) {
        return admission
      }
    }
    return ADMITTED
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
    this.executions.settleSession()
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
      executionTurns: new Map(),
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

  private executionGroup(threadId: string, turnId: string): RosterGroup | undefined {
    return [...this.groups.values()].find((group) => group.executionTurns.get(threadId) === turnId)
  }

  /** Two children can share a trailing path segment; the ordinal keeps their
   *  rows apart without inventing a name the provider never sent. */
  private claimLabel(group: RosterGroup, label: string | null): string {
    const base = label ?? 'subagent'
    const seen = group.labelCounts.get(base) ?? 0
    group.labelCounts.set(base, seen + 1)
    return seen === 0 ? base : `${base} ${seen + 1}`
  }

  private recordExecution(
    group: RosterGroup,
    child: CodexExecutionChild,
    execution: CodexChildExecution | null
  ): void {
    const existing = group.entries.get(child.agentThreadId)
    if (!existing && group.entries.size >= MAX_CODEX_SUBAGENTS_PER_GROUP) {
      return
    }
    const turnId = execution?.turnId ?? null
    const state = execution?.state ?? 'unverifiable'
    const sameTurn = existing && group.executionTurns.get(child.agentThreadId) === turnId
    if (sameTurn && existing.state === state) {
      return
    }
    const now = this.now()
    group.executionTurns.set(child.agentThreadId, turnId)
    group.entries.set(child.agentThreadId, {
      id: child.agentThreadId,
      label: existing?.label ?? this.claimLabel(group, child.label),
      state,
      startedAt: sameTurn ? existing.startedAt : now,
      ...(isTerminalSubagentState(state) ? { settledAt: now } : {}),
      ...(existing?.tokens !== undefined ? { tokens: existing.tokens } : {})
    })
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
