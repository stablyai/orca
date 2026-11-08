import type { AgentJournalProducerLinkage } from '../../shared/agent-session/journal/agent-session-journal-types'
import { namedSubagents } from '../../shared/native-chat/transcript/native-chat-subagent-items'
import type { StructuredAgentSessionLinkageJournal } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import { isBoundedClaudeTaskId } from './claude-background-task-frames'

type Reading = {
  canonicalByToolUse: Map<string, string>
  attemptByAgent: Map<string, number>
  subagents: Set<string>
}

/** The saved identity facts a Claude acquisition reads once, before translating. */
export type ClaudeJournaledIdentities = {
  canonicalByToolUse: [toolUseId: string, agentId: string][]
  attemptByAgent: [agentId: string, attempt: number][]
  subagents: string[]
}

/** One row's contribution, stored beside it so a snapshot never decodes bodies. */
export function claudeAgentRowFacts({
  agentId,
  providerParentRef,
  producerKind,
  attempt
}: AgentJournalProducerLinkage): {
  agentId: string
  parentRef: string | null
  attempt: number
} | null {
  if (producerKind !== 'agent' || agentId === undefined) {
    return null
  }
  // Provisional self-stamps do not establish aliases.
  const aliases =
    providerParentRef !== undefined &&
    agentId !== providerParentRef &&
    isBoundedClaudeTaskId(agentId) &&
    isBoundedClaudeTaskId(providerParentRef)
  return { agentId, parentRef: aliases ? providerParentRef : null, attempt: attempt ?? 1 }
}

/** Visit visible items in insertion order, as the memory journal does. */
export function readClaudeJournaledIdentities(
  visit: StructuredAgentSessionLinkageJournal['visitItemsWithLinkage']
): ClaudeJournaledIdentities {
  const reading = read({ visitItemsWithLinkage: visit })
  return {
    canonicalByToolUse: [...reading.canonicalByToolUse],
    attemptByAgent: [...reading.attemptByAgent],
    subagents: [...reading.subagents]
  }
}

/** Cache per bound journal epoch; reads before binding must not populate the cache. */
export class ClaudeJournaledSubagents {
  private journal: StructuredAgentSessionLinkageJournal | null = null
  private epoch: string | null = null
  private reading: Reading | null = null

  constructor(private readonly bound: () => StructuredAgentSessionLinkageJournal | null) {}

  canonical = (toolUseId: string): string | null =>
    this.current()?.canonicalByToolUse.get(toolUseId) ?? null

  /** Zero means no journaled attempt. */
  attempt = (agentId: string): number => this.current()?.attemptByAgent.get(agentId) ?? 0

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

function read(
  journal: Pick<StructuredAgentSessionLinkageJournal, 'visitItemsWithLinkage'>
): Reading {
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

function readAgentRow(reading: Reading, linkage: AgentJournalProducerLinkage): void {
  const facts = claudeAgentRowFacts(linkage)
  if (!facts) {
    return
  }
  reading.attemptByAgent.set(
    facts.agentId,
    Math.max(facts.attempt, reading.attemptByAgent.get(facts.agentId) ?? 1)
  )
  if (facts.parentRef !== null) {
    reading.canonicalByToolUse.set(facts.parentRef, facts.agentId)
  }
}
