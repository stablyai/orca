import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { DROP_RUN_EVENT_TRIGGERS_SQL } from './db/runs/run-event-capture'
import { readRunEvents } from './db/runs/run-event-read'

describe('recorded Run history', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb
  let runId: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-run-events-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
    runId = db.createRun({
      objective: 'Ship a feature',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: 'tab_a:leaf_a'
    }).id
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps failed and successful attempts and repeated coordinator changes after reopening', () => {
    const task = db.createTask({ runId, spec: 'Do the work', taskTitle: 'Implementation' })
    const failed = createRootDispatch(db, task.id, 'term_worker')
    db.failDispatch(failed.id, 'First attempt failed')
    const succeeded = createRootDispatch(db, task.id, 'term_worker')
    db.updateTaskStatus(task.id, 'completed')
    db.updateTaskStatus(task.id, 'completed')
    db.bindRun({ runId, coordinatorHandle: 'term_b', coordinatorPaneKey: 'tab_b:leaf_b' })
    db.bindRun({ runId, coordinatorHandle: 'term_a', coordinatorPaneKey: 'tab_a:leaf_a' })
    db.bindRun({ runId, coordinatorHandle: 'term_a', coordinatorPaneKey: 'tab_a:leaf_a' })
    const before = readRunEvents(db.db, runId)
    db.close()
    db = new OrchestrationDb(path)
    const after = readRunEvents(db.db, runId)
    expect(after).toEqual(before)
    expect(after.coverage.completeFromCreation).toBe(true)
    expect(after.events.filter((event) => event.kind === 'dispatch.status_changed')).toEqual([
      expect.objectContaining({
        dispatchId: failed.id,
        data: { previousStatus: 'dispatched', status: 'failed', assignee: 'term_worker' }
      }),
      expect.objectContaining({
        dispatchId: succeeded.id,
        data: { previousStatus: 'dispatched', status: 'completed', assignee: 'term_worker' }
      })
    ])
    expect(
      after.events
        .filter((event) => event.kind === 'run.coordinator_changed')
        .map((event) => event.data)
    ).toEqual([
      { previousCoordinator: 'term_a', coordinator: 'term_b', generation: 2 },
      { previousCoordinator: 'term_b', coordinator: 'term_a', generation: 3 }
    ])
    expect(
      after.events.filter(
        (event) => event.kind === 'task.status_changed' && event.data.status === 'completed'
      )
    ).toHaveLength(1)
    expect(
      after.events.every(
        (event, index) => index === 0 || event.sequence > after.events[index - 1]!.sequence
      )
    ).toBe(true)
  })

  it('rolls history back with failed writes and records gate resolution only once', () => {
    const before = readRunEvents(db.db, runId)
    db.db.exec('SAVEPOINT failed_work')
    db.createTask({ runId, spec: 'This transaction will fail' })
    db.db.exec('ROLLBACK TO failed_work; RELEASE failed_work')
    expect(readRunEvents(db.db, runId)).toEqual(before)
    const task = db.createTask({ runId, spec: 'Approval needed' })
    const gate = db.createGate({ taskId: task.id, question: 'Proceed?' })
    db.resolveGate(gate.id, 'yes')
    db.resolveGate(gate.id, 'yes')
    expect(
      readRunEvents(db.db, runId).events.filter((event) => event.kind.startsWith('gate.'))
    ).toEqual([
      expect.objectContaining({
        kind: 'gate.created',
        entityId: gate.id,
        taskId: task.id,
        data: { status: 'pending' }
      }),
      expect.objectContaining({
        kind: 'gate.status_changed',
        entityId: gate.id,
        data: { previousStatus: 'pending', status: 'resolved' }
      })
    ])
  })

  it('refuses a state change if its event cannot be saved', () => {
    const before = readRunEvents(db.db, runId)
    db.db.exec(`CREATE TRIGGER refuse_history BEFORE INSERT ON orchestration_run_events
      WHEN NEW.kind = 'task.created' BEGIN SELECT RAISE(ABORT, 'history write failed'); END;`)
    expect(() => db.createTask({ runId, spec: 'Must not exist without history' })).toThrow(
      'history write failed'
    )
    expect(db.listTasks({ runId })).toEqual([])
    expect(readRunEvents(db.db, runId)).toEqual(before)
  })

  it('pages one bounded snapshot without mixing Runs or admitting later events', () => {
    db.createTask({ runId, spec: 'First' })
    db.createTask({ runId, spec: 'Second' })
    const other = db.createRun({
      objective: 'Other run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    db.createTask({ runId: other.id, spec: 'Other work' })
    const snapshot = readRunEvents(db.db, runId)
    const first = readRunEvents(db.db, runId, { limit: 2 })
    const cursor = first.nextCursor
    expect(cursor).toBeTypeOf('string')
    if (!cursor) {
      throw new Error('Expected a second history page')
    }
    db.createTask({ runId, spec: 'Created while paging' })
    const second = readRunEvents(db.db, runId, { limit: 2, cursor })
    expect([...first.events, ...second.events]).toEqual(snapshot.events)
    expect(second.nextCursor).toBeNull()
    expect(readRunEvents(db.db, runId).events).toHaveLength(snapshot.events.length + 1)
    expect(() => readRunEvents(db.db, other.id, { cursor })).toThrow('cursor is invalid')
    expect(() => readRunEvents(db.db, runId, { cursor: 'invalid' })).toThrow('cursor is invalid')
    expect(() => readRunEvents(db.db, runId, { limit: 101 })).toThrow()
  })

  it('keeps history through task resets and removes it when the Run is deleted', () => {
    const task = db.createTask({ runId, spec: 'Keep its history' })
    db.resetTasks()
    expect(readRunEvents(db.db, runId).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'task.created', entityId: task.id }),
        expect.objectContaining({
          kind: 'task.removed',
          entityId: task.id,
          data: { status: 'ready' }
        })
      ])
    )
    db.resetAll()
    expect(() => readRunEvents(db.db, runId)).toThrow('was not found')
    expect(
      db.db.prepare('SELECT 1 FROM orchestration_run_events WHERE run_id = ?').get(runId)
    ).toBeUndefined()
  })

  it('marks pre-existing and interrupted history incomplete without inventing earlier events', () => {
    db.db.exec(DROP_RUN_EVENT_TRIGGERS_SQL)
    db.db.exec(
      'DELETE FROM orchestration_run_event_coverage; DELETE FROM orchestration_run_events;'
    )
    db.createTask({ runId, spec: 'Before capture was installed' })
    db.close()
    db = new OrchestrationDb(path)
    const before = readRunEvents(db.db, runId)
    expect(before.coverage.completeFromCreation).toBe(false)
    expect(before.events).toEqual([])
    db.createTask({ runId, spec: 'After capture was installed' })
    db.createTask({ runId, spec: 'Next task' })
    const cursor = readRunEvents(db.db, runId, { limit: 1 }).nextCursor
    if (!cursor) {
      throw new Error('Expected a history cursor')
    }
    db.db.exec('DROP TRIGGER trg_run_events_task_created')
    db.createTask({ runId, spec: 'Missing event during interrupted recording' })
    db.close()
    db = new OrchestrationDb(path)
    expect(() => readRunEvents(db.db, runId, { cursor })).toThrow('cursor is invalid')
    expect(readRunEvents(db.db, runId).coverage.completeFromCreation).toBe(false)
    expect(readRunEvents(db.db, runId).events).toHaveLength(2)
  })

  it('marks a migration interval incomplete when migrations removed the recording triggers', () => {
    db.createTask({ runId, spec: 'Recorded before the migration' })
    const before = readRunEvents(db.db, runId)
    db.db.pragma('user_version = 42')
    db.close()
    db = new OrchestrationDb(path)
    const after = readRunEvents(db.db, runId)
    expect(after.events).toEqual(before.events)
    expect(after.coverage.completeFromCreation).toBe(false)
    db.createTask({ runId, spec: 'Recorded after the migration' })
    expect(readRunEvents(db.db, runId).events).toHaveLength(before.events.length + 1)
  })
})
