import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('orchestration worker release inventory', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('transfers ownership on exact reuse and fences release through the old Dispatch', async () => {
    h.setup()
    const first = await h.startSettledWorker('succeeded')
    const originalResource = h.db.getWorkerTerminalResourceByOwner(first.dispatchId)
    expect(originalResource?.ownership_state).toBe('owned')

    const second = await h.startWorker({ terminal: 'term_reminted' })
    const transferred = h.db.getWorkerTerminalResourceByOwner(second.dispatchId)
    expect(transferred?.id).toBe(originalResource?.id)
    expect(transferred?.terminal_handle).toBe('term_reminted')
    expect(h.db.getWorkerTerminalResourceByOwner(first.dispatchId)).toBeUndefined()

    h.inspectProcessLiveness.mockResolvedValueOnce('exited')
    const oldRelease = (await h.call('orchestration.workerRelease', {
      dispatch: first.dispatchId
    })) as { state: string; reason?: string }
    expect(oldRelease).toMatchObject({ state: 'retained', reason: 'ownership_transferred' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    h.settle(second.taskId, second.dispatchId, 'succeeded')
    const newRelease = (await h.call('orchestration.workerRelease', {
      dispatch: second.dispatchId
    })) as { state: string }
    expect(newRelease.state).toBe('released')
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
  })

  it('refuses to settle dead transferred ownership with no durable archive', async () => {
    h.setup()
    const first = await h.startSettledWorker('succeeded')
    const second = await h.startWorker({ terminal: 'term_reminted' })
    h.settle(second.taskId, second.dispatchId, 'succeeded')
    h.inspectProcessLiveness.mockResolvedValue('exited')

    await expect(
      h.call('orchestration.workerRelease', { dispatch: first.dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'ownership_transferred',
      processAction: 'none'
    })
    expect(h.inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(second.dispatchId)?.release_state).not.toBe(
      'released'
    )
  })

  it('rejects exact reuse after release intent instead of closing the new worker', async () => {
    h.setup()
    const first = await h.startSettledWorker('succeeded')
    expect(h.db.requestWorkerTerminalRelease(first.dispatchId).disposition).toBe('requested')
    const nextTask = h.db.createTask({ spec: 'racing reuse', runId: h.activeRunId })

    const attempted = (await h.call('orchestration.workerStart', {
      task: nextTask.id,
      from: 'term_coord',
      terminal: 'term_worker'
    })) as { state: string; lastError?: string }

    expect(attempted).toMatchObject({ state: 'failed' })
    expect(attempted.lastError).toMatch(/release.*progress/i)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    await expect(
      h.call('orchestration.workerRelease', { dispatch: first.dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retains when persisted state has another resource for the exact terminal identity', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const raw = (
      h.db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db
    raw
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
           process_incarnation, host_scope, ownership_state, release_state, retained_reason
         ) VALUES (
           'wtr_conflict', 'ctx_conflict', 'ctx_conflict', 'term_reminted', ?, ?, ?,
           'external', 'retained', 'legacy_ambiguous'
         )`
      )
      .run(
        h.workerPaneKey,
        'runtime_test:term_worker:1',
        JSON.stringify({ kind: 'local', hostId: 'local' })
      )

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('worker-retain records a durable user exception that release can later replace', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const retained = (await h.call('orchestration.workerRetain', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(retained).toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('retained')

    const release = (await h.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(release.state).toBe('released')
  })

  it('worker-list separates terminal accounting from Task outcome', async () => {
    h.setup()
    const active = await h.startWorker()
    const perWorkerLookup = vi.spyOn(h.db, 'getWorkerTerminalResourceByOwner')
    perWorkerLookup.mockClear()
    const result1 = (await h.call('orchestration.workerList', { run: h.activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null; workerState: string }[]
      counts: Record<string, number>
    }
    expect(result1.workers).toHaveLength(1)
    expect(result1.workers[0]).toMatchObject({
      dispatchId: active.dispatchId,
      terminalState: 'active',
      workerState: 'ready'
    })
    expect(perWorkerLookup).not.toHaveBeenCalled()

    h.settle(active.taskId, active.dispatchId, 'succeeded')
    const result2 = (await h.call('orchestration.workerList', {
      run: h.activeRunId,
      terminalState: 'reclaimable'
    })) as { workers: { dispatchId: string }[]; counts: Record<string, number> }
    expect(result2.workers.map((worker) => worker.dispatchId)).toEqual([active.dispatchId])
    expect(result2.counts).toMatchObject({ reclaimable: 1 })

    await h.call('orchestration.workerRelease', { dispatch: active.dispatchId })
    const result3 = (await h.call('orchestration.workerList', { run: h.activeRunId })) as {
      workers: { terminalState: string | null; workerState: string }[]
    }
    expect(result3.workers[0]).toMatchObject({
      terminalState: 'released',
      workerState: 'succeeded'
    })
  })

  it('reports abandoned workers as retained instead of reclaimable', async () => {
    h.setup()
    const { dispatchId } = await h.startWorker()
    await h.call('orchestration.workerAbandon', { dispatch: dispatchId })

    const listed = (await h.call('orchestration.workerList', { run: h.activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null }[]
    }

    expect(listed.workers).toContainEqual(
      expect.objectContaining({ dispatchId, terminalState: 'retained' })
    )
    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none'
    })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('worker-show exposes the terminal resource', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const shown = (await h.call('orchestration.workerShow', { dispatch: dispatchId })) as {
      terminalResource: { ownershipState: string; releaseState: string } | null
    }
    expect(shown.terminalResource).toMatchObject({
      ownershipState: 'owned',
      releaseState: 'not_requested'
    })
  })
})
