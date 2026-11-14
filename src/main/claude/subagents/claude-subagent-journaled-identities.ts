import {
  indexClaudeBackgroundTask,
  selectClaudeBackgroundTask,
  type ClaudeBackgroundTaskIndex,
  type ClaudeBackgroundTaskDescriptor
} from '../background-tasks/claude-background-task-identity'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import type { AgentJournalProducerLinkage } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { namedSubagents } from '../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import type { JournalItemLinkageVisitor } from '../../native-chat/agent-session-journal/journal-store-contracts'
import { isBoundedClaudeTaskId } from '../background-tasks/claude-background-task-frames'
import type { JournalThreadGoalSource } from '../../native-chat/agent-session-journal/projection/journal-thread-goal-source'

type Reading = {
  canonicalByToolUse: Map<string, string>
  attemptByAgent: Map<string, number>
  parents: Map<string, Map<string | undefined, AgentJournalProducerLinkage>>
  backgrounds: Map<string, ClaudeBackgroundTaskIndex>
  subagents: Set<string>
}

/** The saved facts a Claude acquisition reads in one observation, before translating. */
export type ClaudeJournalSnapshot = {
  canonicalByToolUse: [toolUseId: string, agentId: string][]
  attemptByAgent: [agentId: string, attempt: number][]
  parents: [
    agentId: string,
    runs: [run: string | undefined, linkage: AgentJournalProducerLinkage][]
  ][]
  backgrounds: [
    taskId: string,
    index: {
      latest?: ClaudeBackgroundTaskDescriptor
      unresolved?: ClaudeBackgroundTaskDescriptor
      aliases: [string, ClaudeBackgroundTaskDescriptor][]
    }
  ][]
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

/** The memory journal's fold; the SQL journal reads the same facts from claudeAgentRowFacts columns. */
type ClaudeLinkageJournal = {
  visitItemsWithLinkage(visit: JournalItemLinkageVisitor): void
  threadGoalSource(): JournalThreadGoalSource
}

/** Visit visible items in insertion order, as the memory journal does. */
export function readClaudeJournalSnapshot(journal: ClaudeLinkageJournal): ClaudeJournalSnapshot {
  const reading = read(journal)
  return {
    canonicalByToolUse: [...reading.canonicalByToolUse],
    attemptByAgent: [...reading.attemptByAgent],
    parents: [...reading.parents].map(([id, runs]) => [id, [...runs]]),
    backgrounds: [...reading.backgrounds].map(([id, index]) => [
      id,
      {
        ...index,
        aliases: [...index.aliases]
      }
    ]),
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

  parent = (taskId: string, run?: string): string | undefined =>
    (run === undefined
      ? [...(this.read()?.parents.get(taskId)?.values() ?? [])].at(-1)
      : this.read()?.parents.get(taskId)?.get(run)
    )?.parentAgentId

  background = (taskId: string, run?: string): ClaudeBackgroundTaskDescriptor | undefined =>
    selectClaudeBackgroundTask(this.read()?.backgrounds.get(taskId), run)

  isSubagent = (taskId: string): boolean => this.read()?.subagents.has(taskId) === true

  /** Dereference the acquisition's current snapshot; a replacement swaps it whole. */
  private read(): Reading | null {
    const snapshot = this.current()
    if (snapshot !== this.snapshot) {
      this.snapshot = snapshot
      this.reading = snapshot && {
        canonicalByToolUse: new Map(snapshot.canonicalByToolUse),
        attemptByAgent: new Map(snapshot.attemptByAgent),
        parents: new Map(snapshot.parents.map(([id, runs]) => [id, new Map(runs)])),
        backgrounds: new Map(
          snapshot.backgrounds.map(([id, index]) => [
            id,
            {
              ...index,
              aliases: new Map(index.aliases)
            }
          ])
        ),
        subagents: new Set(snapshot.subagents)
      }
    }
    return this.reading
  }
}

function read(journal: Pick<ClaudeLinkageJournal, 'visitItemsWithLinkage'>): Reading {
  const reading: Reading = {
    canonicalByToolUse: new Map(),
    attemptByAgent: new Map(),
    parents: new Map(),
    backgrounds: new Map(),
    subagents: new Set()
  }
  journal.visitItemsWithLinkage((itemId, _sequence, body, linkage) => {
    if (linkage.agentId !== undefined && linkage.producerKind === 'agent') {
      const parents = reading.parents.get(linkage.agentId) ?? new Map()
      parents.delete(linkage.providerParentRef)
      parents.set(linkage.providerParentRef, linkage)
      reading.parents.set(linkage.agentId, parents)
    }
    if (body.kind === 'message') {
      for (const block of body.blocks.filter(isBackgroundTaskBlock)) {
        const index = reading.backgrounds.get(block.taskId) ?? { aliases: new Map() }
        indexClaudeBackgroundTask(index, itemId, block.taskId, block.parentToolUseId, linkage)
        reading.backgrounds.set(block.taskId, index)
      }
    }
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
