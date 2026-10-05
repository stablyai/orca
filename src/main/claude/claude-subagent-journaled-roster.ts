// What earlier runs of this session left of the Claude subagent roster, re-derived
// from the rows they journaled.
//
// The roster lives in one provider process, but everything it writes outlives that
// process: a group row keeps a restart-stable identity, and every agent row names its
// canonical id beside the call its frames arrived under. A run that started from
// nothing re-rostered a resumed child in a second row, restarted its attempts, lost
// the alias its resumed frames still carry, and rewrote the one group row no turn
// owns from empty. So a run reads what earlier runs left instead: derived, never
// stored, so it cannot disagree with the rows it came from.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalProducerLinkage
} from '../../shared/agent-session-journal-types'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
import type { StructuredAgentSessionLinkageJournal } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'
import {
  claudeSubagentGroupIdentity,
  type JournaledClaudeSubagentGroup
} from './claude-subagent-group-row'

/** What the roster asks of earlier runs. */
export type ClaudeJournaledRosterSource = {
  /** The task id an earlier run resolved this spawn call to. */
  canonical: (toolUseId: string) => string | null
  /** The group row an earlier run last listed this child in. */
  groupOf: (entryId: string) => string | null
  /** An earlier run's row for one group, handed over once: after that the
   *  roster's own copy is the newer one. */
  claimGroup: (groupId: string) => JournaledClaudeSubagentGroup | null
  /** The latest run of this child any row records; 1 when none says more. */
  attempt: (agentId: string) => number
}

type JournaledRosterReading = {
  canonicalByToolUse: Map<string, string>
  attemptByAgent: Map<string, number>
  rowsByGroup: Map<string, JournaledClaudeSubagentGroup>
  groupByEntry: Map<string, string>
}

/**
 * Read once per bound journal epoch. Before the journal is bound nothing is read and
 * nothing is kept, so the first read after bind still sees every row.
 */
export class ClaudeJournaledRoster implements ClaudeJournaledRosterSource {
  private journal: StructuredAgentSessionLinkageJournal | null = null
  private epoch: string | null = null
  private reading: JournaledRosterReading | null = null

  constructor(private readonly bound: () => StructuredAgentSessionLinkageJournal | null) {}

  canonical = (toolUseId: string): string | null =>
    this.current()?.canonicalByToolUse.get(toolUseId) ?? null

  groupOf = (entryId: string): string | null => this.current()?.groupByEntry.get(entryId) ?? null

  claimGroup = (groupId: string): JournaledClaudeSubagentGroup | null => {
    const reading = this.current()
    const row = reading?.rowsByGroup.get(groupId) ?? null
    reading?.rowsByGroup.delete(groupId)
    return row
  }

  attempt = (agentId: string): number => this.current()?.attemptByAgent.get(agentId) ?? 1

  private current(): JournaledRosterReading | null {
    const journal = this.bound()
    if (!journal) {
      return null
    }
    if (!this.reading || journal !== this.journal || journal.epoch !== this.epoch) {
      this.journal = journal
      this.epoch = journal.epoch
      this.reading = readJournaledRoster(journal)
    }
    return this.reading
  }
}

function readJournaledRoster(
  journal: StructuredAgentSessionLinkageJournal
): JournaledRosterReading {
  const reading: JournaledRosterReading = {
    canonicalByToolUse: new Map(),
    attemptByAgent: new Map(),
    rowsByGroup: new Map(),
    groupByEntry: new Map()
  }
  // A child two rows list (only an older build wrote that) is the later-created row's: a turn's
  // row is created with its turn, so that is where it last ran.
  const listedAt = new Map<string, number>()
  journal.visitItemsWithLinkage((itemId, sequence, body, attribution) => {
    readAgentRow(reading, attribution)
    const group = body.kind === 'message' ? body.blocks.find(isSubagentGroupBlock) : undefined
    if (!group || itemId !== agentJournalItemKey(claudeSubagentGroupIdentity(group.groupId))) {
      return
    }
    reading.rowsByGroup.set(group.groupId, {
      entries: group.agents,
      turnScope: attribution.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    })
    for (const entry of group.agents) {
      if ((listedAt.get(entry.id) ?? -1) < sequence) {
        listedAt.set(entry.id, sequence)
        reading.groupByEntry.set(entry.id, group.groupId)
      }
    }
  })
  return reading
}

function readAgentRow(
  reading: JournaledRosterReading,
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
