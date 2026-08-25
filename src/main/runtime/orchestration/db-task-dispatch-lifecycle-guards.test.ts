import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

type WorkerFixture = {
  dispatchId: string
  capability: string
  handle: string
  paneKey: string
  processIncarnation: string
}

let db: OrchestrationDb | undefined
let dir: string | undefined

afterEach(() => {
  db?.close()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  db = undefined
  dir = undefined
})

describe('Task/Dispatch lifecycle guards', () => {
  it('rejects a worker report while another supervised Dispatch is active', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'legacy supervised split' })
    const first = startWorker(database, task.id, 'first')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const second = startWorker(database, task.id, 'second')

    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: second.dispatchId,
        outcome: 'succeeded',
        result: 'must wait for first'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(first.dispatchId)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(second.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(first.dispatchId)?.state).toBe('ready')
    expect(database.getWorkerDispatch(second.dispatchId)?.state).toBe('ready')
    expectCapability(database, first, true)
    expectCapability(database, second, true)
  })

  it.each(['succeeded', 'failed'] as const)(
    'settles context-only legacy siblings after a %s worker report',
    (outcome) => {
      const database = createDatabase()
      const task = database.createTask({ spec: 'legacy mixed split' })
      const contextOnly = database.createDispatchContext(task.id, 'term_context')
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const worker = startWorker(database, task.id, 'reporter')

      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: worker.dispatchId,
          outcome,
          result: `${outcome} result`
        })
      ).toEqual({ action: 'settled', outcome, duplicate: false })
      const expectedStatus = outcome === 'succeeded' ? 'completed' : 'failed'
      expect(database.getTask(task.id)?.status).toBe(expectedStatus)
      expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
        status: expectedStatus,
        capability_revoked_at: expect.any(String)
      })
      expect(database.getActiveDispatchForTerminal('term_context')).toBeUndefined()
      expect(() =>
        database.createDispatchContext(
          database.createTask({ spec: 'later context work' }).id,
          'term_context'
        )
      ).not.toThrow()
    }
  )

  it('settles a newer context-only legacy sibling after a worker report', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'reversed legacy mixed split' })
    const worker = startWorker(database, task.id, 'reversed_reporter')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const contextOnly = database.createDispatchContext(task.id, 'term_reversed_context')

    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: worker.dispatchId,
        outcome: 'succeeded',
        result: 'reversed sibling completed'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    expect(database.getTask(task.id)?.status).toBe('completed')
    expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
      status: 'completed',
      capability_revoked_at: expect.any(String)
    })
    expect(database.getActiveDispatchForTerminal('term_reversed_context')).toBeUndefined()
  })

  it('rejects generic failure while a supervised worker remains active', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'supervised failure guard' })
    const worker = startWorker(database, task.id, 'guarded')

    expect(() => database.failDispatch(worker.dispatchId, 'unsafe retry')).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { dispatchId: worker.dispatchId }
      })
    )
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(worker.dispatchId)).toMatchObject({
      status: 'dispatched',
      failure_count: 0,
      capability_revoked_at: null
    })
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
    expectCapability(database, worker, true)
  })

  it('atomically settles worker state when a proven process exit fails its Dispatch', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'exited worker' })
    const worker = startWorker(database, task.id, 'exited')

    expect(
      database.failDispatch(worker.dispatchId, 'process exited', { workerProcessExited: true })
    ).toMatchObject({ status: 'failed', failure_count: 1 })
    expect(database.getTask(task.id)?.status).toBe('ready')
    expect(database.getWorkerDispatch(worker.dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'process_exited',
      last_error: 'process exited'
    })
    expectCapability(database, worker, false)
  })

  it('keeps a Task dispatched when missing-terminal recovery leaves another worker active', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'legacy missing-terminal split' })
    const missing = startWorker(database, task.id, 'missing')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const live = startWorker(database, task.id, 'live')

    database.reconcileMissingWorkerTerminal(missing.dispatchId, 'terminal missing')

    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(missing.dispatchId)).toMatchObject({
      status: 'failed',
      capability_revoked_at: expect.any(String)
    })
    expect(database.getWorkerDispatch(missing.dispatchId)?.state).toBe('abandoned')
    expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(live.dispatchId)?.state).toBe('ready')
    expectCapability(database, missing, false)
    expectCapability(database, live, true)

    database.reconcileMissingWorkerTerminal(live.dispatchId, 'second terminal missing')
    expect(database.getTask(task.id)?.status).toBe('ready')
    expectCapability(database, live, false)
  })

  it.each(['local', 'federated'] as const)(
    'keeps a Task dispatched when a %s worker start fails beside a live worker',
    (kind) => {
      const database = createDatabase()
      const task = database.createTask({ spec: `${kind} split start failure` })
      const failed = database.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        ...(kind === 'federated'
          ? {
              federation: {
                environmentId: 'server-1',
                environmentName: 'worker server',
                peerFingerprint: 'peer-1',
                protocolVersion: 3
              }
            }
          : {})
      })
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const live = startWorker(database, task.id, `${kind}_live`)

      if (kind === 'local') {
        database.failWorkerStart(failed.dispatch.id, 'start_failed', 'worker failed to start')
      } else {
        database.reconcileFederatedWorkerStart({
          dispatchId: failed.dispatch.id,
          state: 'failed',
          stage: 'start_failed',
          lastError: 'worker failed to start'
        })
      }

      expect(database.getTask(task.id)?.status).toBe('dispatched')
      expect(database.getDispatchContextById(failed.dispatch.id)).toMatchObject({
        status: 'failed',
        capability_revoked_at: expect.any(String)
      })
      expect(database.getWorkerDispatch(failed.dispatch.id)?.state).toBe('failed')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
      expect(database.getWorkerDispatch(live.dispatchId)?.state).toBe('ready')
      expectCapability(database, live, true)
    }
  )

  it.each(['stop', 'abandon'] as const)(
    '%s releases the last context-only sibling after a newer worker start fails',
    (operation) => {
      const database = createDatabase()
      const task = database.createTask({ spec: `${operation} historical sibling` })
      const contextOnly = database.createDispatchContext(task.id, `term_${operation}`)
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const failed = database.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

      database.failWorkerStart(failed.dispatch.id, 'start_failed', 'worker failed to start')
      expect(database.getTask(task.id)?.status).toBe('dispatched')

      const released =
        operation === 'stop'
          ? database.beginWorkerStop(contextOnly.id, 'runtime_test')
          : database.abandonWorkerDispatch(contextOnly.id)
      expect(released).toMatchObject({
        disposition: 'context_only',
        alreadySettled: false,
        releasedCurrentTask: true
      })
      expect(database.getTask(task.id)?.status).toBe('blocked')
      expect(database.getDispatchContextById(contextOnly.id)?.status).toBe('failed')
      expect(database.getActiveDispatchForTerminal(`term_${operation}`)).toBeUndefined()
      expect(() =>
        database.createDispatchContext(
          database.createTask({ spec: `${operation} later work` }).id,
          `term_${operation}`
        )
      ).not.toThrow()
    }
  )

  it.each(['stop', 'abandon'] as const)(
    '%s preserves a live worker sibling and lets it report',
    (operation) => {
      const database = createDatabase()
      const task = database.createTask({ spec: `${operation} legacy worker split` })
      const live = startWorker(database, task.id, `${operation}_live`)
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const released = startWorker(database, task.id, `${operation}_released`)

      if (operation === 'stop') {
        expect(database.beginWorkerStop(released.dispatchId, 'runtime_test').disposition).toBe(
          'stopping'
        )
        expect(database.settleWorkerStop(released.dispatchId).state).toBe('stopped')
      } else {
        expect(database.abandonWorkerDispatch(released.dispatchId).disposition).toBe('abandoned')
      }

      expect(database.getTask(task.id)?.status).toBe('dispatched')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
      expectCapability(database, live, true)
      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: live.dispatchId,
          outcome: 'succeeded',
          result: `${operation} sibling completed`
        })
      ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
      expect(database.getTask(task.id)?.status).toBe('completed')
      expectCapability(database, live, false)
    }
  )

  it('blocks a Task when an interleaved stop settles its final active Dispatch', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'interleaved legacy worker release' })
    const stopping = startWorker(database, task.id, 'interleaved_stopping')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const abandoned = startWorker(database, task.id, 'interleaved_abandoned')

    expect(database.beginWorkerStop(stopping.dispatchId, 'runtime_test').disposition).toBe(
      'stopping'
    )
    expect(database.abandonWorkerDispatch(abandoned.dispatchId).disposition).toBe('abandoned')
    expect(database.getTask(task.id)?.status).toBe('dispatched')

    expect(database.settleWorkerStop(stopping.dispatchId).state).toBe('stopped')
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getDispatchContextById(stopping.dispatchId)?.status).toBe('failed')
    expect(database.getDispatchContextById(abandoned.dispatchId)?.status).toBe('failed')
  })

  it('restores a live sibling after stopping an uncertain worker start', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'uncertain legacy worker split' })
    const live = startWorker(database, task.id, 'uncertain_live')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const uncertain = database.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    database.markWorkerStartUnknown(uncertain.dispatch.id, 'agent_readiness', 'outcome unknown')
    expect(database.getTask(task.id)?.status).toBe('blocked')

    expect(database.beginWorkerStop(uncertain.dispatch.id, 'runtime_test').disposition).toBe(
      'stopping'
    )
    expect(database.settleWorkerStop(uncertain.dispatch.id).state).toBe('stopped')
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: live.dispatchId,
        outcome: 'succeeded',
        result: 'live sibling completed'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
  })

  it.each(['federated-reconcile', 'missing-terminal'] as const)(
    'restores a live sibling after an uncertain worker start fails through %s',
    (recovery) => {
      const database = createDatabase()
      const task = database.createTask({ spec: `${recovery} uncertain sibling` })
      const live = startWorker(database, task.id, `${recovery}_live`)
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const uncertain = database.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
      database.markWorkerStartUnknown(uncertain.dispatch.id, 'agent_readiness', 'outcome unknown')

      if (recovery === 'federated-reconcile') {
        database.reconcileFederatedWorkerStart({
          dispatchId: uncertain.dispatch.id,
          state: 'failed',
          stage: 'start_failed',
          lastError: 'worker did not start'
        })
      } else {
        database.reconcileMissingWorkerTerminal(uncertain.dispatch.id, 'worker terminal missing')
      }

      expect(database.getTask(task.id)?.status).toBe('dispatched')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: live.dispatchId,
          outcome: 'succeeded',
          result: 'live sibling completed'
        })
      ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    }
  )

  it('rejects gate creation while a supervised worker remains active', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'worker gate guard' })
    const worker = startWorker(database, task.id, 'gate')

    expect(() => database.createGate({ taskId: task.id, question: 'Proceed?' })).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { taskId: task.id, dispatchId: worker.dispatchId }
      })
    )
    expect(database.listGates({ taskId: task.id })).toHaveLength(0)
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(worker.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
    expectCapability(database, worker, true)
  })

  it('rolls back gate resolution when an active Dispatch blocks readiness', () => {
    const database = createDatabase()
    const task = database.createTask({ spec: 'corrupt gated task' })
    const gate = database.createGate({ taskId: task.id, question: 'Proceed?' })
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const dispatch = database.createDispatchContext(task.id, 'term_worker')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(task.id)

    expect(() => database.resolveGate(gate.id, 'yes')).toThrowError(
      expect.objectContaining({ code: 'task_not_startable' })
    )
    expect(database.getGate(gate.id)).toMatchObject({
      status: 'pending',
      resolution: null,
      resolved_at: null
    })
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })
})

function createDatabase(): OrchestrationDb {
  dir = mkdtempSync(join(tmpdir(), 'orca-task-dispatch-lifecycle-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  return db
}

function startWorker(database: OrchestrationDb, taskId: string, name: string): WorkerFixture {
  const started = database.createStartingWorkerDispatch({ taskId, startOptions: {} })
  const paneSuffix = name.length.toString(16).padStart(12, '0')
  const paneKey = `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${paneSuffix}`
  const processIncarnation = `${name}:1`
  const handle = `term_${name}`
  const capability = database.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation,
    worktreeId: `repo::${name}`,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  database.markWorkerDispatchReady(started.dispatch.id)
  return { dispatchId: started.dispatch.id, capability, handle, paneKey, processIncarnation }
}

function expectCapability(database: OrchestrationDb, worker: WorkerFixture, valid: boolean): void {
  expect(
    database.verifyDispatchCapability({
      dispatchId: worker.dispatchId,
      capability: worker.capability,
      paneKey: worker.paneKey,
      processIncarnation: worker.processIncarnation
    }).valid
  ).toBe(valid)
}

function sqliteFor(database: OrchestrationDb): Database.Database {
  return (database as unknown as { db: Database.Database }).db
}
