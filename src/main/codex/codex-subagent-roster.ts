// The Codex subagent roster: one journal row per spawn group, revised in place.
//
// An announcement supplies membership — a `subAgentActivity` item, or in
// Codex's default multi-agent mode any collab call naming the helper — and
// child turn events supply execution state: each child turn is one run of the
// child. Everything the row says follows the shared subagent tracker's rules;
// this module only reads Codex's events. Rows earlier provider runs journaled
// are inherited, so a restart neither splits a child nor rewrites the row no
// turn owns from one child.

import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { JournaledSubagentGroups } from '../native-chat/subagent-tracker/journaled-subagent-groups'
import { subagentRowSinkPort } from '../native-chat/subagent-tracker/subagent-row-sink-port'
import { SubagentTracker } from '../native-chat/subagent-tracker/subagent-tracker'
import type { SubagentReport } from '../native-chat/subagent-tracker/subagent-tracker-types'
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
import { CodexSubagentLinkage } from './codex-subagent-linkage'
import { codexSubagentGroupId, codexSubagentGroupIdentity } from './codex-subagent-roster-state'
import type { CodexThreadItem } from './codex-structured-item-translation'
import { CodexThreadTokenTotals } from './codex-thread-token-totals'
export { subagentGroupJournalBody as codexSubagentGroupBody } from '../native-chat/agent-session-journal/journal-subagent-group-body'
export { codexSubagentGroupId, codexSubagentGroupIdentity } from './codex-subagent-roster-state'

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
  private readonly tracker: SubagentTracker<AgentJournalTurnScope>
  /** Every thread's total, members or not; a child shows its total once it is listed. */
  private readonly tokensByThread = new CodexThreadTokenTotals()
  /** The one owner of child membership and turn state; the rows of calls on a helper read it too. */
  readonly executions: CodexSubagentExecutions
  private readonly unfollow: () => void
  /** Who produced a row, from what this roster learned about each child thread. */
  readonly linkage: CodexSubagentLinkage

  constructor(private readonly deps: CodexSubagentRosterDeps) {
    this.tracker = new SubagentTracker({
      port: subagentRowSinkPort(deps.sink, codexSubagentGroupIdentity),
      journaled: new JournaledSubagentGroups(
        () => deps.sink.journalLinkage?.() ?? null,
        codexSubagentGroupIdentity
      ),
      ...(deps.now ? { now: deps.now } : {})
    })
    this.executions = deps.executions ?? new CodexSubagentExecutions()
    // The row follows the executions, so every frame that ends a child's turn — its own
    // `turn/completed` (a failed one included) or its thread closing — settles it.
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
    return child?.execution
      ? this.report(child, child.execution, true, this.groupFor(input.threadId, input.turnId))
      : ADMITTED
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
    if (
      input.threadId === this.deps.primaryThreadId() ||
      this.tracker.hasSettled(input.threadId, input.turnId)
    ) {
      return ADMITTED
    }
    const observed = this.executions.observeTurn(input.threadId, input.turnId, input.state)
    // Followed already if the execution changed; re-derived (idempotently) for its admission.
    return observed ? this.follow(observed.child, observed.execution) : ADMITTED
  }

  /** A child turn starting is a run starting; one ending only revises the row listing it. */
  private follow(
    child: Readonly<CodexExecutionChild>,
    execution: CodexChildExecution
  ): StructuredAgentSessionSinkAdmission {
    if (!child.registered) {
      return ADMITTED
    }
    const parent = this.deps.primaryThreadId() ?? child.agentThreadId
    const group = this.groupFor(parent, this.deps.activeTurn(parent) ?? child.parentTurnId)
    return this.report(child, execution, execution.state === 'working', group)
  }

  /** Consume `thread/tokenUsage/updated`. Returns null when the params are not one. */
  handleTokenUsage(params: unknown): StructuredAgentSessionSinkAdmission | null {
    const usage = readCodexThreadTokenTotal(params)
    if (!usage) {
      return null
    }
    this.tokensByThread.record(usage.threadId, usage.totalTokens)
    const located = this.tracker.locate(usage.threadId)
    return located
      ? this.tracker.report({
          id: usage.threadId,
          group: { id: located.group.groupId, placement: () => located.group.placement },
          announces: false,
          tokens: usage.totalTokens
        })
      : ADMITTED
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
    return this.tracker.settleSession()
  }

  dispose(): void {
    this.unfollow()
    this.tracker.dispose()
    this.tokensByThread.clear()
  }

  retentionSizes(): { groups: number; settledIdentities: number } {
    return this.tracker.sizes()
  }

  private report(
    child: Readonly<CodexExecutionChild>,
    execution: CodexChildExecution,
    announces: boolean,
    group: SubagentReport<AgentJournalTurnScope>['group']
  ): StructuredAgentSessionSinkAdmission {
    const tokens = this.tokensByThread.get(child.agentThreadId)
    return this.tracker.report({
      id: child.agentThreadId,
      run: execution.turnId,
      group,
      announces,
      label: child.label,
      state: execution.state,
      ...(typeof tokens === 'number' ? { tokens } : {}),
      // A spawned child may outlive the turn that spawned it.
      backgrounded: true
    })
  }

  /** The group a child spawned now belongs to: the session's own agent's current turn. */
  private groupFor(
    threadId: string,
    turnId: string | null
  ): SubagentReport<AgentJournalTurnScope>['group'] {
    const ownerThreadId = this.deps.primaryThreadId() ?? threadId
    const ownerTurnId =
      ownerThreadId === threadId ? turnId : (this.deps.activeTurn(ownerThreadId) ?? turnId)
    return {
      id: codexSubagentGroupId(ownerThreadId, ownerTurnId),
      placement: () => this.deps.turnScopeFor(ownerThreadId, ownerTurnId),
      outsideTurn: ownerTurnId === null
    }
  }
}
