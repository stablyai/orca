import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../../shared/orchestration-compatibility-evidence'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

type DispatchResult = { dispatch: { id: string; run_id: string; status: string } | null }

describe('orchestration.dispatchShow Run scope', () => {
  const h = createOrchestrationRpcHarness()
  const paneB = 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const workerPane = 'tab_worker:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runA: string

  function authority(
    terminalHandle: string,
    paneKey: string,
    launchTokenHash: string
  ): OrchestrationCompatibilityCallerAuthority {
    return {
      hostScope: { kind: 'local', hostId: 'local' },
      terminalHandle,
      paneKey,
      processIncarnation: `incarnation:${terminalHandle}`,
      launchTokenHash
    }
  }

  function setup(withBoundRun = true): void {
    const state = h.setup(withBoundRun)
    ;({ db, runtime } = state)
    runA = state.activeRunId ?? ''
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => {
      if (handle === 'term_coord') {
        return h.coordinatorPaneKey
      }
      if (handle === 'term_b') {
        return paneB
      }
      if (handle === 'term_worker') {
        return workerPane
      }
      return null
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (evidence?.paneKey === h.coordinatorPaneKey && evidence.launchToken === 'token-a') {
        return authority('term_coord', h.coordinatorPaneKey, 'hash-a')
      }
      if (evidence?.paneKey === paneB && evidence.launchToken === 'token-b') {
        return authority('term_b', paneB, 'hash-b')
      }
      if (evidence?.paneKey === workerPane && evidence.launchToken === 'token-worker') {
        return authority('term_worker', workerPane, 'hash-worker')
      }
      return null
    })
    ctx = callerContext('a')
  }

  function evidenceFor(
    caller: 'a' | 'b' | 'worker',
    terminalHandle?: string
  ): OrchestrationCompatibilityEvidence {
    if (caller === 'a') {
      return {
        terminalHandle: terminalHandle ?? 'term_coord',
        paneKey: h.coordinatorPaneKey,
        launchToken: 'token-a'
      }
    }
    if (caller === 'b') {
      return {
        terminalHandle: terminalHandle ?? 'term_b',
        paneKey: paneB,
        launchToken: 'token-b'
      }
    }
    return {
      terminalHandle: terminalHandle ?? 'term_worker',
      paneKey: workerPane,
      launchToken: 'token-worker'
    }
  }

  function callerContext(caller: 'a' | 'b' | 'worker', terminalHandle?: string): RpcContext {
    return {
      runtime,
      orchestrationCompatibilityEvidence: evidenceFor(caller, terminalHandle)
    }
  }

  function createRunB(): string {
    return db.createRun({
      objective: 'Run B',
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: paneB
    }).id
  }

  async function call(
    params: Record<string, unknown>,
    callContext: RpcContext = ctx
  ): Promise<unknown> {
    return h.call('orchestration.dispatchShow', params, callContext)
  }

  function snapshot(taskIds: string[], dispatchIds: string[]): string {
    return JSON.stringify({
      tasks: taskIds.map((id) => db.getTask(id)),
      dispatches: dispatchIds.map((id) => db.getDispatchContextById(id))
    })
  }

  async function rejection(
    params: Record<string, unknown>,
    callContext: RpcContext = ctx
  ): Promise<{ code: unknown; message: string }> {
    try {
      await call(params, callContext)
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

    const own = (await call({ task: ownTask.id })) as DispatchResult
    const foreign = await call({ task: foreignTask.id })
    const absent = await call({ task: 'task_absent' })

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

    const foreign = await rejection({ task: task.id, preamble: true })
    expect(snapshot([task.id], [])).toBe(before)
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
    raw.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    const absent = await rejection({ task: task.id, preamble: true })

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

    await expect(call({ task: task.id })).resolves.toEqual({ dispatch: null })
    await expect(call({ task: task.id }, callerContext('b'))).resolves.toEqual({ dispatch: null })
    await expect(call({ task: task.id }, { runtime, trustedDesktopIpc: true })).resolves.toEqual({
      dispatch: null
    })
    await expect(call({ task: task.id }, { runtime, clientKind: 'runtime' })).resolves.toEqual({
      dispatch: null
    })
    expect(snapshot([task.id], [dispatch.id])).toBe(before)
  })

  it('allows identity-free reads only from trusted presentation transports', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run B work', runId: runB })
    const dispatch = db.createDispatchContext(task.id, 'term_worker_b')
    const untrusted = await rejection({ task: task.id }, { runtime })
    const forged = await rejection({ task: task.id, callerTerminalHandle: 'term_b' }, { runtime })
    const localDesktop = (await call(
      { task: task.id },
      { runtime, trustedDesktopIpc: true }
    )) as DispatchResult
    const pairedDesktop = (await call(
      { task: task.id },
      { runtime, clientKind: 'runtime' }
    )) as DispatchResult

    expect(untrusted).toEqual(forged)
    expect(untrusted.code).toBe('run_required')
    expect(localDesktop.dispatch?.id).toBe(dispatch.id)
    expect(pairedDesktop.dispatch?.id).toBe(dispatch.id)
  })

  it('ignores a spoofed caller handle and uses only attested identity', async () => {
    setup()
    const runB = createRunB()
    const ownTask = db.createTask({ spec: 'Run A work', runId: runA })
    const ownDispatch = db.createDispatchContext(ownTask.id, 'term_worker_a')
    const foreignTask = db.createTask({ spec: 'Run B work', runId: runB })
    db.createDispatchContext(foreignTask.id, 'term_worker_b')

    const own = (await call({
      task: ownTask.id,
      callerTerminalHandle: 'term_b'
    })) as DispatchResult
    const foreign = await call({
      task: foreignTask.id,
      callerTerminalHandle: 'term_b'
    })

    expect(own.dispatch?.id).toBe(ownDispatch.id)
    expect(foreign).toEqual({ dispatch: null })
  })

  it('fails closed before lookup for malformed and stale caller evidence', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run B private work', runId: runB })
    const dispatch = db.createDispatchContext(task.id, 'term_worker_b')
    const before = snapshot([task.id], [dispatch.id])
    const malformed: RpcContext = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_b',
        paneKey: paneB
      }
    }
    const stale: RpcContext = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_stale',
        paneKey: paneB,
        launchToken: 'wrong-token'
      }
    }
    const lookupSpies = [
      vi.spyOn(db, 'getTask'),
      vi.spyOn(db, 'getTaskForRun'),
      vi.spyOn(db, 'getDispatchContext'),
      vi.spyOn(db, 'getDispatchContextForRun'),
      vi.spyOn(db, 'getDispatchContextForCallerIdentity'),
      vi.spyOn(db, 'getCurrentRunForPane')
    ]

    const malformedForeign = await rejection({ task: task.id }, malformed)
    const malformedAbsent = await rejection({ task: 'task_absent' }, malformed)
    const staleForeign = await rejection({ task: task.id }, stale)

    expect(malformedForeign).toEqual(malformedAbsent)
    expect(staleForeign).toEqual(malformedForeign)
    expect(malformedForeign.code).toBe('run_required')
    expect(lookupSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
    expect(snapshot([task.id], [dispatch.id])).toBe(before)
  })

  it('returns the absent shape for an attested caller without a Run or Dispatch', async () => {
    setup(false)

    await expect(call({ task: 'task_absent' })).resolves.toEqual({ dispatch: null })
  })

  it('keeps completed same-Run dispatches readable without mutating them', async () => {
    setup()
    const task = db.createTask({ spec: 'Settled work', runId: runA })
    const dispatch = db.createDispatchContext(task.id, 'term_worker_a')
    db.updateTaskStatus(task.id, 'completed')
    const before = snapshot([task.id], [dispatch.id])

    const result = (await call({ task: task.id })) as DispatchResult

    expect(result.dispatch).toMatchObject({ id: dispatch.id, status: 'completed' })
    expect(snapshot([task.id], [dispatch.id])).toBe(before)
  })

  it('keeps independent callers scoped without shared authority state', async () => {
    setup()
    const runB = createRunB()
    const taskA = db.createTask({ spec: 'Run A work', runId: runA })
    const dispatchA = db.createDispatchContext(taskA.id, 'term_worker_a')
    const taskB = db.createTask({ spec: 'Run B work', runId: runB })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_worker_b')

    const [aOwn, aForeign, bOwn, bForeign] = (await Promise.all([
      call({ task: taskA.id }),
      call({ task: taskB.id }),
      call({ task: taskB.id }, callerContext('b')),
      call({ task: taskA.id }, callerContext('b'))
    ])) as DispatchResult[]

    expect(aOwn.dispatch?.id).toBe(dispatchA.id)
    expect(bOwn.dispatch?.id).toBe(dispatchB.id)
    expect(aForeign).toEqual({ dispatch: null })
    expect(bForeign).toEqual({ dispatch: null })
  })

  it('uses the binding captured after a deterministic coordinator rebind', async () => {
    setup()
    const runB = createRunB()
    const taskA = db.createTask({ spec: 'Run A work', runId: runA })
    const dispatchA = db.createDispatchContext(taskA.id, 'term_worker_a')
    const taskB = db.createTask({ spec: 'Run B work', runId: runB })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_worker_b')

    const before = (await call({ task: taskA.id })) as DispatchResult
    db.bindRun({
      runId: runB,
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey
    })
    const oldRun = (await call({ task: taskA.id })) as DispatchResult
    const currentRun = (await call({ task: taskB.id })) as DispatchResult

    expect(before.dispatch?.id).toBe(dispatchA.id)
    expect(oldRun).toEqual({ dispatch: null })
    expect(currentRun.dispatch?.id).toBe(dispatchB.id)
  })

  it('uses non-vacuous attested evidence when mixed-version params omit the new field', async () => {
    setup()
    const runB = createRunB()
    const task = db.createTask({ spec: 'Run B work', runId: runB })
    db.createDispatchContext(task.id, 'term_worker_b')
    vi.mocked(runtime.verifyOrchestrationCompatibilityCaller).mockClear()

    await expect(call({ task: task.id })).resolves.toEqual({ dispatch: null })
    expect(runtime.verifyOrchestrationCompatibilityCaller).toHaveBeenCalledWith(evidenceFor('a'), {
      currentRuntimeLaunchSufficient: true,
      allowTerminalHandleRemint: true
    })
  })

  it('lets an attested settled worker inspect only its exact Dispatch', async () => {
    setup()
    const runB = createRunB()
    const ownTask = db.createTask({ spec: 'Worker task', runId: runA })
    const ownDispatch = db.createDispatchContext(
      ownTask.id,
      'term_worker',
      workerPane,
      'hash-worker',
      'incarnation:term_worker'
    )
    db.updateTaskStatus(ownTask.id, 'completed')
    const foreignTask = db.createTask({ spec: 'Foreign task', runId: runB })
    const foreignDispatch = db.createDispatchContext(foreignTask.id, 'term_worker_b')
    const before = snapshot([ownTask.id, foreignTask.id], [ownDispatch.id, foreignDispatch.id])

    const own = (await call({ task: ownTask.id }, callerContext('worker'))) as DispatchResult
    const foreign = await call({ task: foreignTask.id }, callerContext('worker'))
    const absent = await call({ task: 'task_absent' }, callerContext('worker'))

    expect(own.dispatch).toMatchObject({ id: ownDispatch.id, status: 'completed' })
    expect(foreign).toEqual({ dispatch: null })
    expect(foreign).toEqual(absent)
    expect(snapshot([ownTask.id, foreignTask.id], [ownDispatch.id, foreignDispatch.id])).toBe(
      before
    )
  })
})
