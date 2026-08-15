import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  reconcileWorkerDeadlines,
  WORKER_WATCHDOG_SENTINEL_SETTLE_GRACE_MS
} from './worker-deadline-reconciler'
import type { WorkerWatchdogSentinel } from './worker-watchdog-protocol'

describe('worker deadline reconciliation', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  function createWorker(deadlineAt = '2026-08-15T00:00:01.000Z') {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'bounded worker' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      budget: {
        group: 'deadline-workers',
        index: 1,
        maxDispatches: 8,
        maxRuntimeMs: 30_000,
        maxRequests: 10,
        requestCapEnforcement: 'prompt_only',
        maxReviewCycles: 0,
        leaf: true
      },
      deadlineAt
    })
    db.setWorkerWatchdogSentinelPath(started.dispatch.id, '/tmp/ctx_deadline.json')
    db.markWorkerDispatchReady(started.dispatch.id)
    return { task, started }
  }

  function createRemoteWorker(dispatchId = 'ctx_remote_deadline') {
    const deadlineAt = '2026-08-15T00:00:01.000Z'
    const attachment = db!.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote_deadline',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 2,
      runtimeEpoch: 'worker_epoch',
      deadlineAt,
      maxRequests: 10,
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: `request_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `payload_${dispatchId}`
      }
    })
    db!.setRemoteWorkerWatchdogSentinelPath(dispatchId, `/tmp/${dispatchId}.json`)
    return { attachment, deadlineAt }
  }

  function sentinel(
    dispatchId: string,
    deadlineAt: string,
    stop: WorkerWatchdogSentinel['stop']
  ): WorkerWatchdogSentinel {
    return {
      dispatchId,
      startedAt: '2026-08-15T00:00:00.000Z',
      deadlineAt,
      finishedAt: '2026-08-15T00:00:02.000Z',
      exitCode: stop === 'natural' ? 0 : null,
      signal: stop === 'natural' ? null : stop === 'term' ? 'SIGTERM' : 'SIGKILL',
      stop
    }
  }

  it('leaves an already-successful natural exit settled and idempotent', async () => {
    const { task, started } = createWorker()
    db!.settleWorkerReport({
      taskId: task.id,
      dispatchId: started.dispatch.id,
      outcome: 'succeeded',
      result: '{}'
    })
    const payload = sentinel(started.dispatch.id, started.worker.deadline_at, 'natural')
    const result = await reconcileWorkerDeadlines(db!, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })

    expect(result).toEqual([])
    expect(db!.getTask(task.id)?.status).toBe('completed')
    expect(db!.getWorkerDispatch(started.dispatch.id)?.state).toBe('succeeded')
  })

  it('blocks the Task with runtime_budget_exhausted on deadline termination', async () => {
    const { task, started } = createWorker()
    const payload = sentinel(started.dispatch.id, started.worker.deadline_at, 'kill')
    const result = await reconcileWorkerDeadlines(db!, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })

    expect(result).toEqual([
      {
        dispatchId: started.dispatch.id,
        action: 'settled',
        reason: 'runtime_budget_exhausted:kill',
        notifyHandle: `run:${task.run_id}`
      }
    ])
    expect(db!.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'stopped',
      stage: 'runtime_budget_exhausted'
    })
    expect(db!.getTask(task.id)).toMatchObject({
      status: 'blocked',
      result: expect.stringContaining('runtime_budget_exhausted')
    })
  })

  it('does not block a newer Dispatch when stale watchdog evidence arrives', async () => {
    const { task, started } = createWorker()
    db!.updateTaskStatus(task.id, 'ready')
    const replacement = db!.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      budget: {
        group: 'deadline-workers',
        index: 2,
        maxDispatches: 8,
        maxRuntimeMs: 60_000,
        maxRequests: 10,
        requestCapEnforcement: 'prompt_only',
        maxReviewCycles: 0,
        leaf: true
      },
      deadlineAt: '2099-01-01T00:01:00.000Z'
    })
    const payload = sentinel(started.dispatch.id, started.worker.deadline_at, 'kill')
    expect(db!.reconcileWorkerWatchdogSentinel(started.dispatch.id, payload)).toMatchObject({
      changed: true,
      reason: 'runtime_budget_exhausted:kill'
    })

    expect(db!.getWorkerDispatch(started.dispatch.id)?.state).toBe('stopped')
    expect(db!.getTask(task.id)?.status).toBe('dispatched')
    expect(db!.getDispatchContext(task.id)?.id).toBe(replacement.dispatch.id)
  })

  it('settles a current starting Dispatch when watchdog evidence arrives before readiness', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'starting deadline' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      budget: {
        group: 'starting-deadline',
        index: 1,
        maxDispatches: 1,
        maxRuntimeMs: 30_000,
        maxRequests: 10,
        requestCapEnforcement: 'prompt_only',
        maxReviewCycles: 0,
        leaf: true
      },
      deadlineAt: '2026-08-15T00:00:01.000Z'
    })

    db.reconcileWorkerWatchdogSentinel(
      started.dispatch.id,
      sentinel(started.dispatch.id, started.worker.deadline_at, 'kill')
    )

    expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('stopped')
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('imports unknown tree-kill evidence only once', () => {
    const { started } = createWorker()
    const payload = sentinel(started.dispatch.id, started.worker.deadline_at, 'tree_kill_unknown')

    expect(db!.reconcileWorkerWatchdogSentinel(started.dispatch.id, payload).changed).toBe(true)
    expect(db!.reconcileWorkerWatchdogSentinel(started.dispatch.id, payload).changed).toBe(false)
  })

  it('marks a missing sentinel unknown, then imports later evidence exactly once', async () => {
    const { task, started } = createWorker()
    const afterGrace =
      Date.parse(started.worker.deadline_at) + WORKER_WATCHDOG_SENTINEL_SETTLE_GRACE_MS
    const missing = await reconcileWorkerDeadlines(db!, {
      now: () => afterGrace,
      readFileImpl: async () => {
        throw new Error('missing')
      }
    })
    expect(missing[0]?.action).toBe('stop_unknown')
    expect(db!.getWorkerDispatch(started.dispatch.id)?.state).toBe('stop_unknown')

    const payload = sentinel(started.dispatch.id, started.worker.deadline_at, 'tree_kill')
    const imported = await reconcileWorkerDeadlines(db!, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })
    expect(imported[0]?.action).toBe('settled')
    expect(db!.getWorkerDispatch(started.dispatch.id)?.state).toBe('stopped')
    expect(db!.getTask(task.id)?.status).toBe('blocked')
    await expect(
      reconcileWorkerDeadlines(db!, {
        readFileImpl: async () => JSON.stringify(payload) as never
      })
    ).resolves.toEqual([])
  })

  it('reconciles persisted sentinel evidence after a database reopen', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-worker-deadline-reopen-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const task = db.createTask({ spec: 'restart worker' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      budget: {
        group: 'restart-workers',
        index: 1,
        maxDispatches: 1,
        maxRuntimeMs: 30_000,
        maxRequests: 10,
        requestCapEnforcement: 'prompt_only',
        maxReviewCycles: 0,
        leaf: true
      },
      deadlineAt: '2026-08-15T00:00:01.000Z'
    })
    db.setWorkerWatchdogSentinelPath(started.dispatch.id, '/tmp/restart-worker.json')
    db.markWorkerDispatchReady(started.dispatch.id)
    db.close()
    db = new OrchestrationDb(dbPath)

    const payload = sentinel(started.dispatch.id, started.worker.deadline_at, 'term')
    await reconcileWorkerDeadlines(db, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })
    expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('stopped')
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('settles a remote attachment from authoritative watchdog evidence', async () => {
    db = new OrchestrationDb(':memory:')
    const { attachment, deadlineAt } = createRemoteWorker()
    const payload = sentinel(attachment.dispatch_id, deadlineAt, 'kill')
    const result = await reconcileWorkerDeadlines(db, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })

    expect(result).toEqual([
      {
        dispatchId: attachment.dispatch_id,
        action: 'settled',
        reason: 'runtime_budget_exhausted:kill'
      }
    ])
    expect(db.getRemoteDispatchAttachment(attachment.dispatch_id)).toMatchObject({
      state: 'stopped',
      stage: 'runtime_budget_exhausted',
      deadline_at: deadlineAt,
      max_requests: 10
    })
    expect(
      db.listFederationRelay({
        dispatchId: attachment.dispatch_id,
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(1)
    await expect(
      reconcileWorkerDeadlines(db, {
        readFileImpl: async () => JSON.stringify(payload) as never
      })
    ).resolves.toEqual([])
  })

  it('preserves a remote stop_unknown fence across reopen and accepts later evidence', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-remote-worker-deadline-reopen-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const { attachment, deadlineAt } = createRemoteWorker('ctx_remote_reopen')
    const afterGrace = Date.parse(deadlineAt) + WORKER_WATCHDOG_SENTINEL_SETTLE_GRACE_MS
    await reconcileWorkerDeadlines(db, {
      now: () => afterGrace,
      readFileImpl: async () => {
        throw new Error('missing')
      }
    })
    expect(db.getRemoteDispatchAttachment(attachment.dispatch_id)?.state).toBe('stop_unknown')
    expect(
      db.listFederationRelay({
        dispatchId: attachment.dispatch_id,
        direction: 'to_home',
        afterSequence: 0
      })[0]?.payload
    ).toContain('runtime_budget_stop_unknown')
    db.close()
    db = new OrchestrationDb(dbPath)

    const payload = sentinel(attachment.dispatch_id, deadlineAt, 'tree_kill')
    await reconcileWorkerDeadlines(db, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })
    expect(db.getRemoteDispatchAttachment(attachment.dispatch_id)).toMatchObject({
      state: 'stopped',
      stage: 'runtime_budget_exhausted'
    })
    expect(
      db.listFederationRelay({
        dispatchId: attachment.dispatch_id,
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(1)
  })
})
