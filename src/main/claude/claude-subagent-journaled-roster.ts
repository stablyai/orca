// What earlier runs of this session left of the Claude subagent roster, re-derived
// from the rows they journaled.
//
// Beyond the group rows every agent's tracker inherits, a Claude run needs two more
// facts earlier runs recorded on their child rows: the canonical task id each spawn
// call resolved to (a resumed child's frames still carry the old call), and the
// latest run of each child. Both come from the same read of the journal.

import type {
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLinkageJournal } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { JournaledSubagentGroups } from '../native-chat/subagent-tracker/journaled-subagent-groups'
import type { JournaledSubagentSource } from '../native-chat/subagent-tracker/subagent-tracker-types'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'

/** Durable journal identity for a group's row — stable across revisions and
 *  across a restart, so replay finds the same row instead of appending a new one. */
export function claudeSubagentGroupIdentity(groupId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `claude-subagents:${groupId}` }
}

/** What the roster asks of earlier runs. */
export type ClaudeJournaledRosterSource = JournaledSubagentSource<AgentJournalTurnScope> & {
  /** The task id an earlier run resolved this spawn call to. */
  canonical: (toolUseId: string) => string | null
}

type ClaudeAgentRows = {
  canonicalByToolUse: Map<string, string>
  attemptByAgent: Map<string, number>
}

export class ClaudeJournaledRoster implements ClaudeJournaledRosterSource {
  private readonly rows: JournaledSubagentGroups<ClaudeAgentRows>

  constructor(bound: () => StructuredAgentSessionLinkageJournal | null) {
    this.rows = new JournaledSubagentGroups(bound, claudeSubagentGroupIdentity, {
      create: () => ({ canonicalByToolUse: new Map(), attemptByAgent: new Map() }),
      visit: readAgentRow
    })
  }

  canonical = (toolUseId: string): string | null =>
    this.rows.extra()?.canonicalByToolUse.get(toolUseId) ?? null

  groupOf = (entryId: string): string | null => this.rows.groupOf(entryId)

  claimGroup = (groupId: string) => this.rows.claimGroup(groupId)

  attempt = (agentId: string): number => this.rows.extra()?.attemptByAgent.get(agentId) ?? 1
}

function readAgentRow(
  reading: ClaudeAgentRows,
  { agentId, providerParentRef, producerKind, attempt }: AgentJournalProducerLinkage
): void {
  if (producerKind !== 'agent' || agentId === undefined) {
    return
  }
  if (attempt !== undefined && attempt > (reading.attemptByAgent.get(agentId) ?? 1)) {
    reading.attemptByAgent.set(agentId, attempt)
  }
  // A row stamped with its own reference was never resolved, so it names no alias.
  if (
    providerParentRef !== undefined &&
    agentId !== providerParentRef &&
    isBoundedClaudeTaskId(agentId) &&
    isBoundedClaudeTaskId(providerParentRef)
  ) {
    reading.canonicalByToolUse.set(providerParentRef, agentId)
  }
}
