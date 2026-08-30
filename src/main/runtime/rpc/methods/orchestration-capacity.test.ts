import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

describe('orchestration capacity RPC', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runId: string

  afterEach(() => h.cleanup())

  function setup(): void {
    const state = h.setup()
    db = state.db
    runtime = state.runtime
    ctx = state.ctx
    runId = state.activeRunId as string
  }

  it('declares a target and exposes explicitly enrolled ready work', async () => {
    setup()
    const task = db.createTask({ spec: 'eligible backfill', runId })

    await h.call(
      'orchestration.capacityConfigure',
      { target: 2, run: runId, from: 'term_coord' },
      ctx
    )
    await h.call(
      'orchestration.capacityTaskSet',
      { task: task.id, eligible: true, run: runId, from: 'term_coord' },
      ctx
    )
    const shown = (await h.call(
      'orchestration.capacityShow',
      { run: runId, from: 'term_coord' },
      ctx
    )) as { capacity: { targetConcurrency: number; launchableTasks: { id: string }[] } }

    expect(shown.capacity.targetConcurrency).toBe(2)
    expect(shown.capacity.launchableTasks.map((candidate) => candidate.id)).toEqual([task.id])
  })

  it('rejects capacity enrollment outside the bound Run', async () => {
    setup()
    const foreign = db.createRun({
      objective: 'foreign',
      coordinatorHandle: 'term_foreign',
      coordinatorPaneKey: 'foreign:worktree:tab:leaf'
    })
    const task = db.createTask({ spec: 'foreign task', runId: foreign.id })

    await expect(
      h.call(
        'orchestration.capacityTaskSet',
        { task: task.id, eligible: true, run: runId, from: 'term_coord' },
        ctx
      )
    ).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('replays target configuration without applying the mutation twice', async () => {
    setup()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request = {
      authToken: 'local-token',
      method: 'orchestration.capacityConfigure',
      params: { target: 2, run: runId, from: 'term_coord' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'capacity_replay'
    }

    const first = await dispatcher.dispatch({ ...request, id: 'rpc_first' })
    db.configureRunCapacity(runId, 3)
    const replay = await dispatcher.dispatch({ ...request, id: 'rpc_replay' })

    expect(first).toMatchObject({
      ok: true,
      result: { capacity: { targetConcurrency: 2 }, mutation: { replayed: false } }
    })
    expect(replay).toMatchObject({
      ok: true,
      result: { capacity: { targetConcurrency: 2 }, mutation: { replayed: true } }
    })
    expect(db.getRunCapacity(runId).targetConcurrency).toBe(3)
  })
})
