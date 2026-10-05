// The Codex subagent roster: one journal row per spawn group, revised in place.
//
// An announcement supplies membership — a `subAgentActivity` item, or in
// Codex's default multi-agent mode any collab call naming the helper — and
// child turn events supply execution state.
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

import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  readCodexSubagentActivity,
  readCodexSubagentAnnouncements,
  type CodexSubagentAnnouncement,
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
import { CodexSubagentLinkage } from './codex-subagent-linkage'
export { codexSubagentGroupBody } from './codex-subagent-group-body'
export { codexSubagentGroupId, codexSubagentGroupIdentity } from './codex-subagent-roster-state'
import {
  codexSubagentGroupId,
  codexSubagentGroupIdentity,
  type RosterGroup
} from './codex-subagent-roster-state'
import type { CodexThreadItem } from './codex-structured-item-translation'
import {
  MAX_CODEX_SUBAGENT_GROUPS,
  MAX_CODEX_SUBAGENTS_PER_GROUP
} from './codex-structured-journal-limits'
import { CodexThreadTokenTotals } from './codex-thread-token-totals'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export type CodexSubagentRosterDeps = {
  sink: StructuredAgentSessionEventSink
  /** The thread that owns the agent tree; falls back to the event's thread. */
  primaryThreadId: () => string | null
  activeTurn: (threadId: string) => string | null
  turnScopeFor: (threadId: string, turnId: string | null) => AgentJournalTurnScope
  now?: () => number
  executions?: CodexSubagentExecutions
}

export class CodexSubagentRoster {
  private readonly groups = new Map<string, RosterGroup>()
  /** Every thread's total, members or not; children are selected at write time. */
  private readonly tokensByThread = new CodexThreadTokenTotals()
  private readonly now: () => number
  /** The one owner of child membership and turn state; the rows of calls on a helper read it too. */
  readonly executions: CodexSubagentExecutions
  private readonly unfollow: () => void
  /** Who produced a row, from what this roster learned about each child thread. */
  readonly linkage: CodexSubagentLinkage

  constructor(private readonly deps: CodexSubagentRosterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.executions = deps.executions ?? new CodexSubagentExecutions()
    // The row follows the executions, so every frame that ends a child's turn — its own
    // `turn/completed` (a failed one included) or its thread closing — settles it.
    // A refused write clears `lastSerialized`, so the next write of the group retries it.
    this.unfollow = this.executions.onExecutionChanged(
      (child) => child.execution && this.follow(child, child.execution)
    )
    this.linkage = new CodexSubagentLinkage({
      primaryThreadId: deps.primaryThreadId,
      executions: this.executions
    })
  }

  /** Consume an item that announces children. Null means the item is not this roster's to render:
   *  a `subAgentActivity` item renders as the roster row alone, while a collab call keeps its own
   *  row, so it is claimed only to hand back a refused write. */
  handleItem(input: {
    threadId: string
    turnId: string | null
    item: CodexThreadItem
  }): StructuredAgentSessionSinkAdmission | null {
    const refused = readCodexSubagentAnnouncements(input.item, this.deps.primaryThreadId())
      .map((announcement) => this.announce(input, announcement))
      .find((admission) => !admission.accepted)
    return refused ?? (readCodexSubagentActivity(input.item) !== null ? ADMITTED : null)
  }

  private announce(
    input: { threadId: string; turnId: string | null },
    announcement: CodexSubagentAnnouncement
  ): StructuredAgentSessionSinkAdmission {
    const child = this.executions.register(
      announcement.agentThreadId,
      announcement.label,
      announcement.namesParentTurn ? input.turnId : undefined,
      // Only a spawn names the spawner: other announcements ride whichever agent acted.
      announcement.spawned ? input.threadId : undefined
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
    // Followed already if the execution changed; re-derived (idempotently) for its admission.
    return observed ? this.follow(observed.child, observed.execution) : ADMITTED
  }

  private follow(
    child: Readonly<CodexExecutionChild>,
    execution: CodexChildExecution
  ): StructuredAgentSessionSinkAdmission {
    if (!child.registered) {
      return ADMITTED
    }
    if (execution.state === 'working') {
      const parent = this.deps.primaryThreadId() ?? child.agentThreadId
      const group =
        this.executionGroup(child.agentThreadId, execution.turnId) ??
        this.groupFor(parent, this.deps.activeTurn(parent) ?? child.parentTurnId)
      this.recordExecution(group, child, execution)
      return this.write(group)
    }
    for (const group of this.groups.values()) {
      if (group.executionTurns.get(child.agentThreadId) !== execution.turnId) {
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
    this.tokensByThread.record(usage.threadId, usage.totalTokens)
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
    this.unfollow()
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
      turnScope: this.deps.turnScopeFor(ownerThreadId, ownerTurnId),
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
    // Deliberately unstamped: a child's frame can trigger this write, but the
    // row is the PARENT's roster of its children.
    const options = { turnScope: group.turnScope }
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
