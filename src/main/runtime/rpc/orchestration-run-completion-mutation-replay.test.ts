import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { OrchestrationMutationExecutor } from './orchestration-mutation-executor'
import { hashCanonical } from './orchestration-mutation-receipt'
import type { RpcRequest } from './core'

describe('Run completion mutation replay', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  it('re-enters a pending receipt after the completion became durable', async () => {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(database)
    const run = database.createRun({
      objective: 'Complete once',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = database.createTask({ runId: run.id, spec: 'Required work' })
    database.updateTaskStatus(task.id, 'completed', 'Done')
    const completion = {
      runId: run.id,
      summary: 'All required work passed.',
      evidence: ['Focused tests passed.'],
      waivers: [],
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord',
      coordinatorGeneration: run.consumer_generation
    }
    const params = {
      id: run.id,
      summary: completion.summary,
      evidence: completion.evidence
    }
    const request: RpcRequest = {
      id: 'rpc_run_complete',
      method: 'orchestration.runComplete',
      params,
      orchestrationRequestId: 'run_complete_request'
    } as RpcRequest
    database.completeRun(completion)
    database.beginMutationReceipt({
      callerFingerprint: 'coordinator',
      requestId: 'run_complete_request',
      method: request.method,
      payloadHash: hashCanonical({ method: request.method, params })
    })
    const invoke = vi.fn(() => database.completeRun(completion))

    await expect(
      new OrchestrationMutationExecutor(runtime).run(request, params, invoke, 'coordinator')
    ).resolves.toMatchObject({
      duplicate: true,
      mutation: { requestId: 'run_complete_request', replayed: true }
    })
    expect(invoke).toHaveBeenCalledOnce()
    expect(database.getMutationReceipt('coordinator', 'run_complete_request')?.state).toBe(
      'completed'
    )
  })
})
