import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

// Why (#4389): two orchestrators in different worktrees of one Orca instance
// must not see or mutate each other's runs, tasks, or dispatches.
describe('OrchestrationDb workspace scoping', () => {
  const KEY_A = 'worktree:wt_a'
  const KEY_B = 'worktree:wt_b'
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('returns each workspace its own active run', () => {
    const d = createDb()
    const runA = d.createCoordinatorRun({
      spec: 'a',
      coordinatorHandle: 'coord_a',
      workspaceKey: KEY_A
    })
    const runB = d.createCoordinatorRun({
      spec: 'b',
      coordinatorHandle: 'coord_b',
      workspaceKey: KEY_B
    })

    expect(d.getActiveCoordinatorRun(KEY_A)?.id).toBe(runA.id)
    expect(d.getActiveCoordinatorRun(KEY_B)?.id).toBe(runB.id)
    expect(d.getActiveCoordinatorRunForWorkspace(KEY_A)?.id).toBe(runA.id)
    expect(d.getActiveCoordinatorRunForWorkspace(KEY_B)?.id).toBe(runB.id)
    expect(d.getActiveCoordinatorRunForHandle('coord_a')?.id).toBe(runA.id)
    expect(d.getActiveCoordinatorRunForHandle('coord_b')?.id).toBe(runB.id)
    expect(d.getActiveCoordinatorRunForHandle('coord_missing')).toBeUndefined()
  })

  it('indexes active coordinator lookup by handle', () => {
    const d = createDb()
    const sqlite = (d as unknown as { db: Database.Database }).db
    const indexes = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_coordinator_runs_handle_status'`
      )
      .all()

    expect(indexes).toHaveLength(1)
  })

  it('shares a legacy run without crossing scoped runs', () => {
    const d = createDb()
    const legacy = d.createCoordinatorRun({ spec: 'legacy', coordinatorHandle: 'coord' })
    expect(d.getActiveCoordinatorRun(KEY_A)?.id).toBe(legacy.id)
    expect(d.getActiveCoordinatorRunForWorkspace(KEY_A)).toBeUndefined()

    const runA = d.createCoordinatorRun({
      spec: 'a',
      coordinatorHandle: 'coord_a',
      workspaceKey: KEY_A
    })
    expect(d.getActiveCoordinatorRun(KEY_B)?.id).toBe(legacy.id)
    expect(d.getActiveCoordinatorRunForWorkspace(KEY_B)).toBeUndefined()
    expect(d.getActiveCoordinatorRunForWorkspace(KEY_A)?.id).toBe(runA.id)
  })

  it('lists scoped tasks without returning another workspace', () => {
    const d = createDb()
    const taskA = d.createTask({ spec: 'a-work', workspaceKey: KEY_A })
    const taskB = d.createTask({ spec: 'b-work', workspaceKey: KEY_B })
    const legacy = d.createTask({ spec: 'legacy-work' })

    const aReady = d.listTasks({ ready: true, workspaceKey: KEY_A }).map((task) => task.id)
    expect(aReady).toContain(taskA.id)
    expect(aReady).toContain(legacy.id)
    expect(aReady).not.toContain(taskB.id)
    expect(
      d
        .listTasks({ workspaceKey: KEY_A })
        .map((task) => task.id)
        .sort()
    ).toEqual([taskA.id, legacy.id].sort())
    expect(d.listTasks()).toHaveLength(3)
  })

  it('does not promote dependencies owned by another workspace', () => {
    const d = createDb()
    const taskA = d.createTask({ spec: 'a', workspaceKey: KEY_A })
    const taskB = d.createTask({ spec: 'b', deps: [taskA.id], workspaceKey: KEY_B })

    d.updateTaskStatus(taskA.id, 'completed')

    expect(d.getTask(taskB.id)?.status).toBe('pending')
  })

  it('does not surface another workspace stale dispatches', () => {
    const d = createDb()
    const taskA = d.createTask({ spec: 'a-work', workspaceKey: KEY_A })
    const taskB = d.createTask({ spec: 'b-work', workspaceKey: KEY_B })
    const ctxA = d.createDispatchContext(taskA.id, 'term_a')
    const ctxB = d.createDispatchContext(taskB.id, 'term_b')

    const future = new Date(Date.now() + 60_000).toISOString()
    const staleA = d.getStaleDispatches(future, KEY_A).map((context) => context.id)
    expect(staleA).toContain(ctxA.id)
    expect(staleA).not.toContain(ctxB.id)
  })

  it('lists only pending gates owned by the coordinator workspace', () => {
    const d = createDb()
    const taskA = d.createTask({ spec: 'a-work', workspaceKey: KEY_A })
    const taskB = d.createTask({ spec: 'b-work', workspaceKey: KEY_B })
    const gateA = d.createGate({ taskId: taskA.id, question: 'A?' })
    d.createGate({ taskId: taskB.id, question: 'B?' })

    expect(d.listPendingGatesForWorkspace(KEY_A).map((gate) => gate.id)).toEqual([gateA.id])
  })

  it('keeps terminals with a foreign active dispatch globally unavailable', () => {
    const d = createDb()
    d.insertMessage({ from: 'coord_a', to: 'term_a', subject: 'known terminal' })
    d.insertMessage({ from: 'coord_b', to: 'term_b', subject: 'known terminal' })
    const taskA = d.createTask({ spec: 'a-work', workspaceKey: KEY_A })
    const taskB = d.createTask({ spec: 'b-work', workspaceKey: KEY_B })
    d.createDispatchContext(taskA.id, 'term_a')
    d.createDispatchContext(taskB.id, 'term_b')

    const idle = d.getIdleTerminals()
    expect(idle).not.toContain('term_a')
    expect(idle).not.toContain('term_b')
  })
})
