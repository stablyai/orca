import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  DISPATCHES_CREATED_BY_ANY_SQL,
  DISPATCH_LINKS_CREATED_BY_ANY_SQL
} from './dispatch-context-store'

let db: OrchestrationDb | null = null

function openDb(): OrchestrationDb {
  db = new OrchestrationDb(':memory:')
  return db
}

function insert(
  target: OrchestrationDb,
  id: string,
  status: string,
  creator: { session?: string; pane?: string }
): void {
  target.db
    .prepare(
      `INSERT INTO dispatch_contexts (id, task_id, status, creator_orca_session_id, creator_pane_key)
       VALUES (?, 'task', ?, ?, ?)`
    )
    .run(id, status, creator.session ?? null, creator.pane ?? null)
}

afterEach(() => {
  vi.useRealTimers()
  db?.close()
  db = null
})

describe('listDispatchesCreatedByAny', () => {
  it('returns every unsettled Dispatch the creators made, plus only their newest settled ones', () => {
    const target = openDb()
    insert(target, 'old-live', 'dispatched', { session: 'chat' })
    for (let index = 0; index < 5; index += 1) {
      insert(target, `done-${index}`, 'completed', { pane: 'run-term' })
    }
    insert(target, 'stranger', 'dispatched', { session: 'other-chat' })

    const created = target.listDispatchesCreatedByAny(
      { orcaSessionIds: ['chat'], paneKeys: ['run-term'] },
      2
    )

    expect(created.map((dispatch) => dispatch.id).sort()).toEqual(['done-3', 'done-4', 'old-live'])
    expect(created).toContainEqual({
      id: 'done-4',
      creatorOrcaSessionId: null,
      creatorPaneKey: 'run-term'
    })
  })

  it('finds creators through their indexes, never by scanning every Dispatch', () => {
    const target = openDb()
    const plan = target.db
      .prepare(`EXPLAIN QUERY PLAN ${DISPATCHES_CREATED_BY_ANY_SQL}`)
      .all('[]', '[]', 20)
      .map((row) => (typeof row === 'object' && row !== null && 'detail' in row ? row.detail : ''))

    expect(plan).toContainEqual(expect.stringContaining('idx_dispatch_creator_orca_session_id'))
    expect(plan).toContainEqual(expect.stringContaining('idx_dispatch_creator_pane_key'))
    expect(plan).not.toContain('SCAN dispatch_contexts')
  })
})

describe('listDispatchLinksCreatedByAny', () => {
  it('reads the time a Dispatch completed as completion wrote it', () => {
    const target = openDb()
    insert(target, 'done', 'dispatched', { session: 'chat' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 11, 2, 5, 19, 286))
    target.completeDispatch('done')

    const [link] = target.listDispatchLinksCreatedByAny({ orcaSessionIds: ['chat'], paneKeys: [] })

    expect(link).toMatchObject({ status: 'completed', at: Date.UTC(2026, 10, 11, 2, 5, 19, 286) })
  })

  it('returns every Dispatch the creators made, of any age, with who runs it', () => {
    const target = openDb()
    for (let index = 0; index < 30; index += 1) {
      insert(target, `done-${index}`, 'completed', { pane: 'run-term' })
    }
    insert(target, 'live', 'dispatched', { session: 'chat' })
    target.db
      .prepare(
        `UPDATE dispatch_contexts SET assignee_orca_session_id = 'worker-chat', completed_at = '2026-11-10 12:00:00' WHERE id = 'live'`
      )
      .run()
    insert(target, 'stranger', 'dispatched', { session: 'other-chat' })

    const links = target.listDispatchLinksCreatedByAny({
      orcaSessionIds: ['chat'],
      paneKeys: ['run-term']
    })

    expect(links).toHaveLength(31)
    expect(links.find((entry) => entry.id === 'live')).toMatchObject({
      status: 'dispatched',
      creatorOrcaSessionId: 'chat',
      assigneeOrcaSessionId: 'worker-chat',
      at: Date.UTC(2026, 10, 10, 12)
    })
  })

  it('finds creators through their indexes, never by scanning every Dispatch', () => {
    const target = openDb()
    const plan = target.db
      .prepare(`EXPLAIN QUERY PLAN ${DISPATCH_LINKS_CREATED_BY_ANY_SQL}`)
      .all('[]', '[]')
      .map((row) => (typeof row === 'object' && row !== null && 'detail' in row ? row.detail : ''))

    expect(plan).toContainEqual(expect.stringContaining('idx_dispatch_creator_orca_session_id'))
    expect(plan).toContainEqual(expect.stringContaining('idx_dispatch_creator_pane_key'))
    expect(plan).not.toContain('SCAN d')
  })
})
