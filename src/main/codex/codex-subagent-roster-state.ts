// One spawn group's roster state, and the ids its journal row is keyed on.

import type {
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import { SubagentRosterRetention } from '../native-chat/subagent-roster-retention'
import {
  MAX_CODEX_SUBAGENT_GROUPS,
  MAX_CODEX_SUBAGENTS_PER_GROUP
} from './codex-structured-journal-limits'

/** The turn a group belongs to when Codex reports activity outside any turn.
 *  Mirrors the generic-frame bucket name so the two read alike in the journal. */
export type RosterGroup = {
  groupId: string
  identity: AgentJournalItemIdentity
  /** The spawning turn's scope: the row reports its children beside that turn's work. */
  turnScope: AgentJournalTurnScope
  /** Insertion order is the display order; the map holds the state. */
  entries: Map<string, NativeChatSubagentEntry>
  executionTurns: Map<string, string | null>
  /** Times each label has been claimed, so a repeat gets an ordinal suffix. */
  labelCounts: Map<string, number>
  /** Last body written, so an idempotent replay writes no new revision. */
  lastSerialized: string | null
}

/** A reused child thread starts a new execution only when its turn id changes. */
export function codexSubagentExecutionIdentity(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId])
}

export function retainSupersededCodexExecution(
  group: RosterGroup,
  threadId: string,
  nextTurnId: string | null,
  retention: SubagentRosterRetention<RosterGroup>
): void {
  const previousTurnId = group.executionTurns.get(threadId)
  const previous = group.entries.get(threadId)
  if (
    typeof previousTurnId === 'string' &&
    previousTurnId !== nextTurnId &&
    previous &&
    isTerminalSubagentState(previous.state)
  ) {
    retention.rememberSettled(codexSubagentExecutionIdentity(threadId, previousTurnId))
  }
}

export function createCodexSubagentRosterRetention(groups: Map<string, RosterGroup>) {
  return new SubagentRosterRetention(groups, {
    maxGroups: MAX_CODEX_SUBAGENT_GROUPS,
    maxSettledIdentities: MAX_CODEX_SUBAGENT_GROUPS * MAX_CODEX_SUBAGENTS_PER_GROUP,
    entries: (group) => group.entries.values(),
    identities: (group) =>
      [...group.executionTurns].flatMap(([threadId, turnId]) =>
        turnId === null ? [] : [codexSubagentExecutionIdentity(threadId, turnId)]
      )
  })
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
