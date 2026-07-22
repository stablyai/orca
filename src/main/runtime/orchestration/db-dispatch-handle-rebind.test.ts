import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('OrchestrationDb dispatch handle rebind', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  // Real leaf UUIDs: pane keys are `${tabId}:${leafUuid}`; only the leaf is
  // remint-stable identity (tab half can change on pane break-out).
  const LEAF_A = '11111111-1111-1111-8111-111111111111'

  it('rebinds an active dispatch when the same pane remints a new handle', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const original = d.createDispatchContext(task.id, 'term_old', `tab_1:${LEAF_A}`)

    const recovered = d.createDispatchContext(task.id, 'term_new', `tab_1:${LEAF_A}`)

    expect(recovered.id).toBe(original.id)
    expect(recovered.assignee_handle).toBe('term_new')
    expect(recovered.assignee_pane_key).toBe(`tab_1:${LEAF_A}`)
    expect(recovered.status).toBe('dispatched')
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getActiveDispatchForTerminal('term_old')).toBeUndefined()
    expect(d.getActiveDispatchForTerminal('term_new')?.id).toBe(original.id)
  })

  it('recovers divergent ready+active state by rebinding the same-pane dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const original = d.createDispatchContext(task.id, 'term_old', `tab_1:${LEAF_A}`)
    // Simulate the pre-fix crash-recovery path that flipped only the task row.
    const sqlite = (d as unknown as { db: Database.Database }).db
    sqlite.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    expect(d.getTask(task.id)?.status).toBe('ready')
    expect(d.getActiveDispatchForTask(task.id)?.id).toBe(original.id)

    const recovered = d.createDispatchContext(task.id, 'term_new', `tab_2:${LEAF_A}`)

    expect(recovered.id).toBe(original.id)
    expect(recovered.assignee_handle).toBe('term_new')
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('task-update ready releases the active dispatch without burning failure budget', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_old', `tab_1:${LEAF_A}`)

    d.updateTaskStatus(task.id, 'ready')

    const released = d.getDispatchContextById(ctx.id)
    expect(d.getTask(task.id)?.status).toBe('ready')
    expect(released?.status).toBe('failed')
    expect(released?.failure_count).toBe(0)
    expect(d.getActiveDispatchForTask(task.id)).toBeUndefined()

    const next = d.createDispatchContext(task.id, 'term_new', `tab_1:${LEAF_A}`)
    expect(next.id).not.toBe(ctx.id)
    expect(next.failure_count).toBe(0)
  })
})
