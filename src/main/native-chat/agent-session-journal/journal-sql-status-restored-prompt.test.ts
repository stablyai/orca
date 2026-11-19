import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  codexProviderHandle,
  agentSessionJournalProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { JOURNAL_ASYNC_QUESTION_INDEXES } from './database/journal-async-question-index'
import { JOURNAL_PROMPT_POSITION_INDEX } from './database/journal-prompt-position-index'
import { prepareJournalDomainImport } from './journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from './journal-domain-import-rows'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlRestoredPrompt } from './journal-sql-status-restored-prompt'

const cleanup: Database.Database[] = []
afterEach(() => {
  for (const db of cleanup.splice(0)) {
    db.close()
  }
})

const providerHandle = agentSessionJournalProviderHandle({
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
})
const base = { v: 4 as const, epoch: 'epoch', seq: 1, ts: 100, fence: 1 }
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

function item(
  itemId: string,
  body: Extract<JournalRow, { kind: 'item' }>['body'],
  turnItemId?: string
): JournalRow {
  return {
    ...base,
    kind: 'item',
    itemId,
    revision: 1,
    ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {}),
    body
  }
}

function approval(itemId: string, state: 'cancelled' | 'resolved', turnItemId: string) {
  return item(
    itemId,
    {
      kind: 'approval',
      title: 'Run a command?',
      detail: 'pnpm test',
      options: [{ id: 'allow', label: 'Allow', intent: 'allow_once' }],
      requestDigest: `digest-${itemId}`,
      resolution: {
        state,
        selectedOptionId: state === 'resolved' ? 'allow' : null,
        resolvedBy: null,
        resolvedAt: null,
        endedBy: 'agent_exit'
      }
    },
    turnItemId
  )
}

function restored(rows: JournalRow[]) {
  const { db: source } = openJournalDatabase(':memory:')
  cleanup.push(source)
  runJournalTransaction(source, () => {
    publishJournalSessionEpoch(source, { sessionId: 'chat', workspaceId: 'workspace' }, 'epoch')
    insertJournalRow(source, 'chat', {
      ...base,
      kind: 'epoch',
      reason: 'session_created',
      providerHandle
    })
    rows.forEach((row, index) =>
      insertJournalRow(source, 'chat', { ...row, seq: index + 2, ts: (index + 2) * 100 })
    )
  })
  const imported = prepareJournalDomainImport(source, 'chat')!
  const db = new Database(':memory:')
  cleanup.push(db)
  migrateJournalDomainSchema(db)
  db.exec(JOURNAL_ASYNC_QUESTION_INDEXES)
  db.exec(JOURNAL_PROMPT_POSITION_INDEX)
  runJournalTransaction(db, () => {
    for (const page of imported.pages) {
      insertJournalDomainImportPage(db, { sessionId: 'chat', epoch: 'epoch' }, page)
    }
    finishJournalDomainImport(db, imported)
  })
  const prepare = vi.spyOn(db, 'prepare')
  const found = readJournalSqlRestoredPrompt(
    new JournalSqlStatusContext(new JournalSqlScope(db, 'chat', 'epoch')),
    0
  )
  return { db, found, statements: prepare.mock.calls.map(([sql]) => String(sql)) }
}

const turn = (id: string) => item(id, { kind: 'turn', turnId: id, state: 'interrupted' })

it('finds the prompt an exited agent waited on until the chat moves on', () => {
  const waiting = [
    item('ask', message('Fix the tests')),
    turn('t1'),
    approval('card', 'cancelled', 't1')
  ]
  expect(restored(waiting).found?.itemId).toBe('card')

  expect(restored([...waiting, item('reply', message('never mind'))]).found).toBeNull()
  expect(restored([...waiting, turn('t2')]).found).toBeNull()
  expect(
    restored([item('ask', message('Go')), turn('t1'), approval('card', 'resolved', 't1')]).found
  ).toBeNull()
  // Two waiting in one turn can't be told apart when the agent asks again.
  expect(restored([...waiting, approval('second', 'cancelled', 't1')]).found).toBeNull()
})

it('seeks the newest prompt without walking or sorting earlier ones', () => {
  const history = Array.from({ length: 40 }, (_, index) =>
    approval(`old-${index}`, 'resolved', 't0')
  )
  const { db, statements } = restored([
    turn('t0'),
    ...history,
    turn('t1'),
    approval('card', 'cancelled', 't1')
  ])
  const latest = statements.find((sql) => sql.includes("kind IN ('approval','question')"))!
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${latest}`)
    .all('chat', 'epoch', 2)
    .map((row) => String(row.detail))
    .join('\n')
  expect(plan).toContain('journal_items_prompt_position')
  expect(plan).not.toContain('TEMP B-TREE')
})
