// What earlier runs of this session recorded about its Claude subagents, re-derived from the rows
// they journaled: the task id each spawn call resolved to (a resumed child's frames still carry the
// old call), the latest run of each child, and which task ids were subagents at all.

import type { AgentJournalProducerLinkage } from '../../shared/agent-session-journal-types'
import { namedSubagents } from '../../shared/native-chat-subagent-items'
import type { StructuredAgentSessionLinkageJournal } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'

type Reading = {
  canonicalByToolUse: Map<string, string>
  attemptByAgent: Map<string, number>
  subagents: Set<string>
}

/** Read once per bound journal epoch. Before the journal is bound nothing is read and nothing is
 *  kept, so the first read after bind still sees every row. */
export class ClaudeJournaledSubagents {
  private journal: StructuredAgentSessionLinkageJournal | null = null
  private epoch: string | null = null
  private reading: Reading | null = null

  constructor(private readonly bound: () => StructuredAgentSessionLinkageJournal | null) {}

  /** The task id an earlier run resolved this spawn call to. */
  canonical = (toolUseId: string): string | null =>
    this.current()?.canonicalByToolUse.get(toolUseId) ?? null

  /** The latest run any row records for this child; 0 when no row names it. */
  attempt = (agentId: string): number => this.current()?.attemptByAgent.get(agentId) ?? 0

  /** An earlier run saved this task as a subagent, so it is not a background task. */
  isSubagent = (taskId: string): boolean => this.current()?.subagents.has(taskId) === true

  private current(): Reading | null {
    const journal = this.bound()
    if (!journal) {
      return null
    }
    if (!this.reading || journal !== this.journal || journal.epoch !== this.epoch) {
      this.journal = journal
      this.epoch = journal.epoch
      this.reading = read(journal)
    }
    return this.reading
  }
}

function read(journal: StructuredAgentSessionLinkageJournal): Reading {
  const reading: Reading = {
    canonicalByToolUse: new Map(),
    attemptByAgent: new Map(),
    subagents: new Set()
  }
  journal.visitItemsWithLinkage((_itemId, _sequence, body, linkage) => {
    readAgentRow(reading, linkage)
    if (body.kind === 'message' && linkage.agentId === undefined) {
      for (const entry of body.blocks.flatMap(namedSubagents)) {
        reading.subagents.add(entry.id)
      }
    }
  })
  return reading
}

function readAgentRow(
  reading: Reading,
  { agentId, providerParentRef, producerKind, attempt }: AgentJournalProducerLinkage
): void {
  if (producerKind !== 'agent' || agentId === undefined) {
    return
  }
  reading.attemptByAgent.set(
    agentId,
    Math.max(attempt ?? 1, reading.attemptByAgent.get(agentId) ?? 1)
  )
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
