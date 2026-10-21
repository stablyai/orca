import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { WorkInboxStore, WORK_INBOX_SCHEMA_SQL } from './work-inbox-store'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(WORK_INBOX_SCHEMA_SQL)
  const store = new WorkInboxStore(db)
  const item = store.create({
    asker: {
      handle: 'agent-original',
      paneKey: null,
      projectId: 'folder-project',
      projectLabel: 'Folder',
      worktreeId: null,
      agentKind: 'codex'
    },
    question: 'Approve deployment?',
    optionLabels: ['Yes (recommended)', 'No'],
    allowFreeText: true,
    requestId: 'original-request',
    now: 1
  })
  return { db, store, item }
}
describe('Work Inbox closure lifecycle', () => {
  it('deduplicates identical asks and rejects reuse of their request ID for different intent', () => {
    const { store, item } = fixture()
    const args = {
      asker: {
        handle: 'agent-original',
        paneKey: null,
        projectId: 'folder-project',
        projectLabel: 'Folder',
        worktreeId: null,
        agentKind: 'codex'
      },
      question: 'Approve deployment?',
      optionLabels: ['Yes (recommended)', 'No'],
      allowFreeText: true,
      requestId: 'original-request',
      now: 10
    }
    expect(store.create(args).id).toBe(item.id)
    expect(() => store.create({ ...args, question: 'Delete the project?' })).toThrow(
      'different question'
    )
    expect(store.list({}).items).toHaveLength(1)
  })
  it('retries an answer once and keeps a separate receipt state', () => {
    const { store, item } = fixture()
    const answer = {
      id: item.id,
      expectedRevision: 0,
      clientRequestId: 'answer-1',
      optionId: 'opt_2'
    }
    expect(store.answer(answer, 2)).toMatchObject({ status: 'ok', item: { status: 'answered' } })
    expect(store.answer(answer, 3)).toMatchObject({ status: 'ok', item: { revision: 1 } })
    expect(store.answer({ ...answer, optionId: 'opt_1' }, 4).status).toBe('conflict')
    expect(store.acknowledge(item.id, 5)).toMatchObject({
      status: 'ok',
      item: { status: 'delivered' }
    })
    expect(store.acknowledge(item.id, 6).status).toBe('ok')
  })
  it('retains a pending question in a reopened SQLite database without resetting older tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-inbox-restart-'))
    const path = join(root, 'orchestration.db')
    let db = new Database(path)
    try {
      db.exec(
        "CREATE TABLE existing_state (value TEXT); INSERT INTO existing_state VALUES ('retained')"
      )
      db.exec(WORK_INBOX_SCHEMA_SQL)
      const item = new WorkInboxStore(db).create({
        asker: {
          handle: 'agent',
          paneKey: null,
          projectId: 'folder',
          projectLabel: 'Folder',
          worktreeId: null,
          agentKind: null
        },
        question: 'Continue?',
        optionLabels: [],
        allowFreeText: true,
        requestId: 'persisted',
        now: 1
      })
      db.close()
      db = new Database(path)
      db.exec(WORK_INBOX_SCHEMA_SQL)
      const store = new WorkInboxStore(db)
      expect(store.list({ projectId: 'folder', agentId: 'agent' }).items).toEqual([item])
      expect(db.prepare('SELECT value FROM existing_state').get()).toMatchObject({
        value: 'retained'
      })
      expect(
        store.answer(
          { id: item.id, expectedRevision: 0, clientRequestId: 'after-restart', text: 'Continue' },
          2
        ).status
      ).toBe('ok')
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('closes without an answer, retains history, reopens the same question and accepts an explicit answer', () => {
    const { store, item } = fixture()
    const request = { id: item.id, expectedRevision: item.revision }
    expect(store.cancel(request, 2)).toMatchObject({
      status: 'ok',
      item: { status: 'cancelled', revision: 1 }
    })
    expect(store.get(item.id)?.answer).toBeUndefined()
    expect(store.list({ view: 'open' })).toEqual({ items: [], openCount: 0 })
    expect(store.list({ view: 'history' }).items).toHaveLength(1)
    expect(store.acknowledge(item.id, 3).status).toBe('conflict')
    const reopen = { id: item.id, expectedRevision: 1 }
    expect(store.reopen(reopen)).toMatchObject({
      status: 'ok',
      item: { id: item.id, revision: 2, status: 'open', cancelledAt: 2 }
    })
    expect(store.reopen(reopen).status).toBe('ok')
    expect(store.cancel(request, 4).status).toBe('conflict')
    expect(
      store.answer({ ...request, clientRequestId: 'old-answer', optionId: 'opt_1' }, 4).status
    ).toBe('conflict')
    expect(
      store.answer(
        { id: item.id, expectedRevision: 2, clientRequestId: 'new-answer', text: 'No deployment' },
        5
      )
    ).toMatchObject({ status: 'ok', item: { answer: { text: 'No deployment' } } })
    expect(store.reopen({ id: item.id, expectedRevision: 3 }).status).toBe('conflict')
  })
  it('preserves an answer when closing races with submission and rejects missing items', () => {
    const { store, item } = fixture()
    store.answer(
      { id: item.id, expectedRevision: 0, clientRequestId: 'answer', optionId: 'opt_2' },
      2
    )
    expect(store.cancel({ id: item.id, expectedRevision: 0 }, 3).status).toBe('conflict')
    expect(store.get(item.id)?.answer?.optionId).toBe('opt_2')
    expect(store.reopen({ id: 'missing', expectedRevision: 0 }).status).toBe('not-found')
  })
})
