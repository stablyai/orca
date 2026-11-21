import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { createRootDispatch } from './root-dispatch-test-fixture'

const runId = 'run_legacy_local'

describe('worker status notice', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  it('tells the listener which Dispatch a settlement wrote, whichever writer made it', () => {
    db = new OrchestrationDb(':memory:')
    const told: (string | null)[] = []
    db.workerStatusListener = (dispatchId) => told.push(dispatchId)
    const first = createRootDispatch(db, db.createTask({ runId, spec: 'one' }).id, 'term_a')
    const second = createRootDispatch(db, db.createTask({ runId, spec: 'two' }).id, 'term_b')
    told.length = 0
    db.completeDispatch(first.id)
    expect(new Set(told)).toEqual(new Set([first.id]))
    told.length = 0
    db.failDispatch(second.id, 'gone')
    expect(new Set(told)).toEqual(new Set([second.id]))
  })

  it('keeps a write when the listener throws', () => {
    db = new OrchestrationDb(':memory:')
    db.workerStatusListener = () => {
      throw new Error('listener broke')
    }
    const dispatch = createRootDispatch(db, db.createTask({ runId, spec: 'one' }).id, 'term_a')
    db.completeDispatch(dispatch.id)
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })

  it('names the creating chat when one of its workers is recorded or changes state', async () => {
    db = new OrchestrationDb(':memory:')
    const sessions: string[] = []
    db.sessionWorkersListener = (sessionId) => sessions.push(sessionId)
    const insertDispatch = db.db.prepare(
      `INSERT INTO dispatch_contexts (id, task_id, status, creator_orca_session_id)
       VALUES (?, 'task', 'dispatched', ?)`
    )
    const insertWorker = db.db.prepare(
      `INSERT INTO worker_dispatches (dispatch_id, state, stage, start_options)
       VALUES (?, 'starting', 'accepted', '{}')`
    )
    insertDispatch.run('from-chat', 'chat-1')
    insertDispatch.run('from-terminal', null)
    expect(sessions).toEqual([])
    insertWorker.run('from-chat')
    insertWorker.run('from-terminal')
    await Promise.resolve()
    expect(sessions).toEqual(['chat-1'])
    const setState = db.db.prepare('UPDATE worker_dispatches SET state = ? WHERE dispatch_id = ?')
    setState.run('ready', 'from-chat')
    setState.run('ready', 'from-chat')
    setState.run('ready', 'from-terminal')
    await Promise.resolve()
    expect(sessions).toEqual(['chat-1', 'chat-1'])
  })
})
