// The ids a Codex spawn group's journal row is keyed on.

import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'

const OUTSIDE_TURN = 'outside-turn'

/** Group identity: the parent turn that spawned the children. `agentPath` is a
 *  tree rooted at the parent thread, so every child of one turn shares a row
 *  no matter which thread's stream carried its activity item. */
export function codexSubagentGroupId(threadId: string, turnId: string | null): string {
  return `${threadId}:${turnId ?? OUTSIDE_TURN}`
}

/** The group of children reported outside any of the parent's turns. */
export function isCodexOutsideTurnGroup(groupId: string): boolean {
  return groupId.endsWith(`:${OUTSIDE_TURN}`)
}

/** Durable journal identity for the group's row — stable across revisions and
 *  across a restart, so replay finds the same row instead of appending a new one. */
export function codexSubagentGroupIdentity(groupId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `codex-subagents:${groupId}` }
}
