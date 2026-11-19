import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { runJournalTransaction } from './database/journal-database'
import { readJournalDomainRestartCut } from './journal-sql-restart-cut'

const target = { sessionId: 'chat', epoch: 'epoch' }
const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function chat() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,900,1)`
  ).run(target.sessionId, target.epoch)
  const seed = (item: AgentJournalRenderItem) =>
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, {
        item,
        ordinal: item.sequence,
        hidden: false,
        ownerFence: 1
      })
    )
  // Settlement rewrites a row at the chat's head, keeping its place in admission order.
  const rewrite = (item: AgentJournalRenderItem, ordinal: number) =>
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, {
        item,
        previous: { item, ordinal, hidden: false },
        hidden: false,
        ownerFence: 1
      })
    )
  return { seed, rewrite, read: () => readJournalDomainRestartCut(db, target) }
}

const IN_TURN = { kind: 'turn', turnItemId: 'turn:2' } as const
const settled = { recovered: true, recoveredAt: 50 } as const

function row(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence, body, ...extra }
}
const user = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

it('reads the newest turn, and the rows a restart settled in it, not the transcript', () => {
  const { seed, read } = chat()
  seed(row('turn:1', 1, { kind: 'turn', turnId: '1', state: 'completed' }))
  seed(row('user:2', 2, user('second')))
  seed(row('turn:2', 3, { kind: 'turn', turnId: '2', state: 'interrupted' }, settled))
  seed(row('reply', 4, { kind: 'message', role: 'assistant', blocks: [] }, { turnScope: IN_TURN }))
  seed(
    row(
      'ask',
      5,
      {
        kind: 'approval',
        title: 'Run the command?',
        detail: null,
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: 50 }
      },
      { turnScope: IN_TURN, ...settled }
    )
  )

  const cut = read()
  expect(cut.turn?.itemId).toBe('turn:2')
  expect(cut.movedOn).toBe(false)
  expect(cut.recovered.map((item) => item.itemId)).toEqual(['turn:2', 'ask'])

  seed(row('user:3', 6, user('third')))
  expect(read().movedOn).toBe(true)
})

it("counts a person's message sent during the cut turn, though settlement moved the turn after it", () => {
  const { seed, rewrite, read } = chat()
  seed(row('turn:2', 3, { kind: 'turn', turnId: '2', state: 'running' }))
  seed(row('user:steer', 4, user('use the other branch')))
  rewrite(row('turn:2', 10, { kind: 'turn', turnId: '2', state: 'interrupted' }, settled), 3)
  expect(read().movedOn).toBe(true)
})

it("does not count a child agent's user-role row as the person moving on", () => {
  const { seed, read } = chat()
  seed(row('turn:2', 3, { kind: 'turn', turnId: '2', state: 'interrupted' }, settled))
  seed(row('child:prompt', 4, user('review the diff'), { agentId: 'child-1', turnScope: IN_TURN }))
  expect(read().movedOn).toBe(false)
})
