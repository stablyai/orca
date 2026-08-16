import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

type DispatchResult = { dispatch: { id: string; run_id: string; status: string } | null }

describe('orchestration.dispatchShow Run scope', () => {
  const h = createOrchestrationRpcHarness()
  const paneB = 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runA: string

  function setup(withBoundRun = true): void {
    const state = h.setup(withBoundRun)
    ;({ db, runtime, ctx } = state)
    runA = state.activeRunId ?? ''
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => {
      if (handle === 'term_coord') {
        return h.coordinatorPaneKey
      }
      if (handle === 'term_b') {
        return paneB
      }
      return null
    })
  }

  function createRunB(): string {
    return db.createRun({
      objective: 'Run B',
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: paneB
    }).id
  }

  async function call(params: Record<string, unknown>): Promise<unknown> {
    return h.call('orchestration.dispatchShow', params, ctx)
  }

  function snapshot(taskIds: string[], dispatchIds: string[]): string {
    return JSON.stringify({
      tasks: taskIds.map((id) => db.getTask(id)),
      dispatches: dispatchIds.map((id) => db.getDispatchContextById(id))
    })
  }

  async function rejection(params: Record<string, unknown>): Promise<{
    code: unknown
    message: string
  }> {
    try {
      await call(params)
      throw new Error('Expected dispatchShow to reject')
    } catch (error) {
      return {
        code: (error as { code?: unknown }).code,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  afterEach(() => h.cleanup())

  it('allows same-Run reads and makes foreign reads identical to absent reads', async () => {
    setup()
    const runB = createRunB()
    const ownTask = db.createTask({ spec: 'Run A work', runId: runA })
    const ownDispatch = db.createDispatchContext(ownTask.id, 'term_worker_a')
    const foreignTask = db.createTask({ spec: 'Run B private work', runId: runB })
    const foreignDispatch = db.createDispatchContext(foreignTask.id, 'term_worker_b')
    const before = snapshot([ownTask.id, foreignTask.id], [ownDispatch.id, foreignDispatch.id])

    const own = (await call({
      task: ownTask.id,
      callerTerminalHandle: 'term_coord'
    })) as DispatchResult
    const foreign = await call({
      task: foreignTask.id,
      callerTerminalHandle: 'term_coord'
    })
    const absent = await call({
      task: 'task_absent',
      callerTerminalHandle: 'term_coord'
    })

    expect(own.dispatch?.id).toBe(ownDispatch.id)
    expect(foreign).toEqual({ dispatch: null })
    expect(foreign).toEqual(absent)
    expect(snapshot([ownTask.id, foreignTask.id], [ownDispatch.id, foreignDispatch.id])).toBe(
      before
    )
  })

  it('makes foreign and absent preamble failures indistinguishable', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run B private work', runId: runB })
    const before = snapshot([task.id], [])

    const foreign = await rejection({
      task: task.id,
      preamble: true,
      callerTerminalHandle: 'term_coord'
    })
    expect(snapshot([task.id], [])).toBe(before)
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
    raw.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    const absent = await rejection({
      task: task.id,
      preamble: true,
      callerTerminalHandle: 'term_coord'
    })

    expect(foreign).toEqual(absent)
    expect(foreign.code).toBe('task_not_found')
  })

  it('does not cross a persisted task/dispatch Run mismatch', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run A work', runId: runA })
    const dispatch = db.createDispatchContext(task.id, 'term_worker_a')
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
    raw.prepare('UPDATE dispatch_contexts SET run_id = ? WHERE id = ?').run(runB, dispatch.id)
    const before = snapshot([task.id], [dispatch.id])

    await expect(call({ task: task.id, callerTerminalHandle: 'term_coord' })).resolves.toEqual({
      dispatch: null
    })
    await expect(call({ task: task.id, callerTerminalHandle: 'term_b' })).resolves.toEqual({
      dispatch: null
    })
    expect(snapshot([task.id], [dispatch.id])).toBe(before)
  })

  it('preserves identity-free desktop navigation reads', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run B work', runId: runB })
    const dispatch = db.createDispatchContext(task.id, 'term_worker_b')

    const result = (await call({ task: task.id })) as DispatchResult

    expect(result.dispatch?.id).toBe(dispatch.id)
  })

  it('fails closed for identified callers without a current Run or stable pane', async () => {
    setup(false)

    await expect(
      call({ task: 'task_absent', callerTerminalHandle: 'term_coord' })
    ).rejects.toMatchObject({ code: 'run_required' })
    await expect(
      call({ task: 'task_absent', callerTerminalHandle: 'term_stale' })
    ).rejects.toMatchObject({ code: 'stable_pane_required' })
  })

  it('keeps completed same-Run dispatches readable without mutating them', async () => {
    setup()
    const task = db.createTask({ spec: 'Settled work', runId: runA })
    const dispatch = db.createDispatchContext(task.id, 'term_worker_a')
    db.updateTaskStatus(task.id, 'completed')
    const before = snapshot([task.id], [dispatch.id])

    const result = (await call({
      task: task.id,
      callerTerminalHandle: 'term_coord'
    })) as DispatchResult

    expect(result.dispatch).toMatchObject({ id: dispatch.id, status: 'completed' })
    expect(snapshot([task.id], [dispatch.id])).toBe(before)
  })

  it('isolates concurrent callers from independent Runs', async () => {
    setup()
    const runB = createRunB()
    const taskA = db.createTask({ spec: 'Run A work', runId: runA })
    const dispatchA = db.createDispatchContext(taskA.id, 'term_worker_a')
    const taskB = db.createTask({ spec: 'Run B work', runId: runB })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_worker_b')

    const [aOwn, aForeign, bOwn, bForeign] = (await Promise.all([
      call({ task: taskA.id, callerTerminalHandle: 'term_coord' }),
      call({ task: taskB.id, callerTerminalHandle: 'term_coord' }),
      call({ task: taskB.id, callerTerminalHandle: 'term_b' }),
      call({ task: taskA.id, callerTerminalHandle: 'term_b' })
    ])) as DispatchResult[]

    expect(aOwn.dispatch?.id).toBe(dispatchA.id)
    expect(bOwn.dispatch?.id).toBe(dispatchB.id)
    expect(aForeign).toEqual({ dispatch: null })
    expect(bForeign).toEqual({ dispatch: null })
  })

  it('uses the current Run binding after a deterministic coordinator rebind', async () => {
    setup()
    const runB = createRunB()
    const taskA = db.createTask({ spec: 'Run A work', runId: runA })
    const dispatchA = db.createDispatchContext(taskA.id, 'term_worker_a')
    const taskB = db.createTask({ spec: 'Run B work', runId: runB })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_worker_b')

    const before = (await call({
      task: taskA.id,
      callerTerminalHandle: 'term_coord'
    })) as DispatchResult
    db.bindRun({
      runId: runB,
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey
    })
    const [oldRun, currentRun] = (await Promise.all([
      call({ task: taskA.id, callerTerminalHandle: 'term_coord' }),
      call({ task: taskB.id, callerTerminalHandle: 'term_coord' })
    ])) as DispatchResult[]

    expect(before.dispatch?.id).toBe(dispatchA.id)
    expect(oldRun).toEqual({ dispatch: null })
    expect(currentRun.dispatch?.id).toBe(dispatchB.id)
  })

  it('uses attested caller evidence when mixed-version params omit the new field', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run B work', runId: runB })
    db.createDispatchContext(task.id, 'term_worker_b')
    ctx = {
      ...ctx,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_coord',
        paneKey: h.coordinatorPaneKey
      }
    }

    await expect(call({ task: task.id })).resolves.toEqual({ dispatch: null })
  })
})
