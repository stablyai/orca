import type { AgentJournalProducerLinkage } from '../../shared/agent-session/journal/agent-session-journal-types'
import { namedSubagents } from '../../shared/native-chat/transcript/native-chat-subagent-items'
import type { StructuredAgentSessionLinkageJournal } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import { isBoundedClaudeTaskId } from './claude-background-task-frames'
import type { JournalThreadGoalSource } from '../native-chat/agent-session-journal/projection/journal-thread-goal-source'

type Reading = {
  canonicalByToolUse: Map<string, string>
  attemptByAgent: Map<string, number>
  subagents: Set<string>
}

/** The saved facts a Claude acquisition reads in one observation, before translating. */
export type ClaudeJournalSnapshot = {
  canonicalByToolUse: [toolUseId: string, agentId: string][]
  attemptByAgent: [agentId: string, attempt: number][]
  subagents: string[]
  threadGoal: JournalThreadGoalSource
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
export function readClaudeJournalSnapshot(
  journal: Pick<StructuredAgentSessionLinkageJournal, 'visitItemsWithLinkage' | 'threadGoalSource'>
): ClaudeJournalSnapshot {
  const reading = read(journal)
  return {
    canonicalByToolUse: [...reading.canonicalByToolUse],
    attemptByAgent: [...reading.attemptByAgent],
    subagents: [...reading.subagents],
    threadGoal: journal.threadGoalSource()
  }
}

/** Cache per bound journal epoch; reads before binding must not populate the cache. */
export class ClaudeJournaledSubagents {
  private snapshot: ClaudeJournalSnapshot | null = null
  private reading: Reading | null = null

  constructor(private readonly current: () => ClaudeJournalSnapshot | null) {}

  canonical = (toolUseId: string): string | null =>
    this.read()?.canonicalByToolUse.get(toolUseId) ?? null

  /** Zero means no journaled attempt. */
  attempt = (agentId: string): number => this.read()?.attemptByAgent.get(agentId) ?? 0

  isSubagent = (taskId: string): boolean => this.read()?.subagents.has(taskId) === true

  /** Dereference the acquisition's current snapshot; a replacement swaps it whole. */
  private read(): Reading | null {
    const snapshot = this.current()
    if (snapshot !== this.snapshot) {
      this.snapshot = snapshot
      this.reading = snapshot && {
        canonicalByToolUse: new Map(snapshot.canonicalByToolUse),
        attemptByAgent: new Map(snapshot.attemptByAgent),
        subagents: new Set(snapshot.subagents)
      }
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
