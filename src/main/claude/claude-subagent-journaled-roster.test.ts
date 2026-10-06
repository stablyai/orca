import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { StructuredAgentSessionLinkageJournal } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeSubagentGroupBody, claudeSubagentGroupIdentity } from './claude-subagent-group-row'
import { ClaudeJournaledRoster } from './claude-subagent-journaled-roster'

type Row = {
  itemId: string
  sequence: number
  body: AgentJournalItemBody
  linkage: AgentJournalProducerLinkage & { turnScope?: AgentJournalTurnScope }
}

const prose: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'working on it' }]
}

const agentRow = (sequence: number, linkage: AgentJournalProducerLinkage): Row => ({
  itemId: `claude:claude-session:row-${sequence}`,
  sequence,
  body: prose,
  linkage
})

const groupRow = (
  sequence: number,
  groupId: string,
  agents: NativeChatSubagentEntry[],
  itemId = agentJournalItemKey(claudeSubagentGroupIdentity(groupId)),
  turnScope?: AgentJournalTurnScope
): Row => ({
  itemId,
  sequence,
  body: claudeSubagentGroupBody(groupId, agents),
  linkage: turnScope ? { turnScope } : {}
})

const entry = (id: string, state: NativeChatSubagentEntry['state']): NativeChatSubagentEntry => ({
  id,
  label: `Child ${id}`,
  state,
  startedAt: 1
})

function linkageJournal(
  epoch: string,
  rows: () => Row[]
): {
  epoch: string
  visitItemsWithLinkage: StructuredAgentSessionLinkageJournal['visitItemsWithLinkage']
} {
  return {
    epoch,
    visitItemsWithLinkage: (visit) => {
      for (const row of rows()) {
        visit(row.itemId, row.sequence, row.body, row.linkage)
      }
    }
  }
}

describe('ClaudeJournaledRoster', () => {
  it('recalls only an agent row that resolved its reference to another id', () => {
    const rows = [
      agentRow(1, { agentId: 'task-a', providerParentRef: 'toolu_a', producerKind: 'agent' }),
      // Stamped with its own reference: never resolved, so it names no alias.
      agentRow(2, { agentId: 'toolu_raw', providerParentRef: 'toolu_raw', producerKind: 'agent' }),
      // A backgrounded shell is not a subagent and never outlives its process.
      agentRow(3, {
        agentId: 'shell-1',
        providerParentRef: 'toolu_shell',
        producerKind: 'background'
      })
    ]
    const journal = linkageJournal('epoch-1', () => rows)
    const journaled = new ClaudeJournaledRoster(() => journal)
    expect(journaled.canonical('toolu_a')).toBe('task-a')
    expect(journaled.canonical('toolu_raw')).toBeNull()
    expect(journaled.canonical('toolu_shell')).toBeNull()
  })

  it('reads the latest run any row of a child records', () => {
    const rows = [
      agentRow(1, { agentId: 'task-a', providerParentRef: 'toolu_a', producerKind: 'agent' }),
      agentRow(2, {
        agentId: 'task-a',
        providerParentRef: 'toolu_a',
        producerKind: 'agent',
        attempt: 3
      }),
      agentRow(3, {
        agentId: 'task-a',
        providerParentRef: 'toolu_a',
        producerKind: 'agent',
        attempt: 2
      })
    ]
    const journal = linkageJournal('epoch-1', () => rows)
    const journaled = new ClaudeJournaledRoster(() => journal)
    expect(journaled.attempt('task-a')).toBe(3)
    expect(journaled.attempt('task-unknown')).toBe(1)
  })

  it('hands an earlier run’s group over once, and places a child in the newest row listing it', () => {
    const turnA: AgentJournalTurnScope = {
      kind: 'turn',
      turnItemId: 'claude:claude-session:turn-a'
    }
    const rows = [
      groupRow(
        10,
        'turn-a',
        [entry('task-a', 'failed'), entry('task-b', 'failed')],
        undefined,
        turnA
      ),
      groupRow(20, 'turn-b', [entry('task-a', 'working')]),
      // Another lane's group block under a key this roster never writes.
      groupRow(30, 'turn-c', [entry('task-c', 'working')], 'orca:elsewhere')
    ]
    const journal = linkageJournal('epoch-1', () => rows)
    const journaled = new ClaudeJournaledRoster(() => journal)
    expect(journaled.groupOf('task-a')).toBe('turn-b')
    expect(journaled.groupOf('task-b')).toBe('turn-a')
    expect(journaled.groupOf('task-c')).toBeNull()
    const claimed = journaled.claimGroup('turn-a')
    expect(claimed?.entries.map((agent) => agent.id)).toEqual(['task-a', 'task-b'])
    // The row keeps the turn it was created beside.
    expect(claimed?.turnScope).toEqual(turnA)
    // After that the roster's own copy is the newer one.
    expect(journaled.claimGroup('turn-a')).toBeNull()
  })

  it('reads nothing before the journal is bound, and does not keep that answer', () => {
    let bound: StructuredAgentSessionLinkageJournal | null = null
    const journaled = new ClaudeJournaledRoster(() => bound)
    expect(journaled.canonical('toolu_a')).toBeNull()
    expect(journaled.claimGroup('turn-a')).toBeNull()
    bound = linkageJournal('epoch-1', () => [
      agentRow(1, { agentId: 'task-a', providerParentRef: 'toolu_a', producerKind: 'agent' }),
      groupRow(2, 'turn-a', [entry('task-a', 'failed')])
    ])
    expect(journaled.canonical('toolu_a')).toBe('task-a')
    expect(journaled.claimGroup('turn-a')?.entries).toHaveLength(1)
  })

  it('re-reads the same journal once its epoch is replaced', () => {
    let rows = [
      agentRow(1, { agentId: 'task-a', providerParentRef: 'toolu_a', producerKind: 'agent' })
    ]
    const journal = linkageJournal('epoch-1', () => rows)
    const journaled = new ClaudeJournaledRoster(() => journal)
    expect(journaled.canonical('toolu_a')).toBe('task-a')
    rows = [agentRow(1, { agentId: 'task-b', providerParentRef: 'toolu_b', producerKind: 'agent' })]
    journal.epoch = 'epoch-2'
    expect(journaled.canonical('toolu_a')).toBeNull()
    expect(journaled.canonical('toolu_b')).toBe('task-b')
  })
})
