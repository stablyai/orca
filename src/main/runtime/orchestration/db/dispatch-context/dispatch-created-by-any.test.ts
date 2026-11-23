import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

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
})

describe('listDispatchLinksCreatedByAny', () => {
  it('returns every Dispatch the creators made, of any age, with who runs it', () => {
    const target = openDb()
    for (let index = 0; index < 29; index += 1) {
      insert(target, `done-${index}`, 'completed', { pane: 'run-term' })
    }
    insert(target, 'live', 'dispatched', { session: 'chat' })
    target.db
      .prepare(
        `UPDATE dispatch_contexts SET assignee_orca_session_id = 'worker-chat', completed_at = '2026-11-10 12:00:00' WHERE id = 'live'`
      )
      .run()
    insert(target, 'stranger', 'dispatched', { session: 'other-chat' })
    insert(target, 'just-finished', 'dispatched', { session: 'chat' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 11, 2, 5, 19, 286))
    target.completeDispatch('just-finished')

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
    expect(links.find((entry) => entry.id === 'just-finished')).toMatchObject({
      status: 'completed',
      at: Date.UTC(2026, 10, 11, 2, 5, 19, 286)
    })
  })
})
