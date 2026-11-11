import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { startFederatedWorker } from '../../../../orchestration/legacy-remote-home/federated-worker-start'
import { mapRuntimeError } from '../../../errors'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'

describe('federated launcher refusal classification', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it.each(['agent_not_available', 'remote_runtime_unavailable', 'ssh_host_not_served'])(
    'preserves the typed %s RPC refusal',
    (code) => {
      const refusal = new OrchestrationError(code, 'Execution-host admission refused.', {
        effects: []
      })
      expect(mapRuntimeError('admission', { runtimeId: 'worker' }, refusal)).toMatchObject({
        ok: false,
        error: { code, message: 'Execution-host admission refused.', data: { effects: [] } }
      })
    }
  )

  it('durably fails a known unavailable-launcher dispatch instead of making its outcome unknown', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_worker',
      name: 'worker',
      peerFingerprint: 'worker_peer',
      pairingRevision: 1
    })
    const refusal = mapRuntimeError(
      'attach',
      { runtimeId: 'worker' },
      new OrchestrationError('agent_not_available', 'Codex is not installed on the worker host.')
    )
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_server, method) => {
        if (method === 'status.get') {
          return {
            ...runtime.getStatus(),
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        throw new OrchestrationError(refusal.error.code, refusal.error.message)
      }
    )
    const run = db.createRun({
      objective: 'Exercise durable admission refusal',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ runId: run.id, spec: 'Run Codex on the worker host' })

    const result = await startFederatedWorker({
      runtime,
      db,
      params: WorkerStartParams.parse({
        from: 'term_coord',
        task: task.id,
        on: 'worker',
        worktree: 'folder:worker',
        agent: 'codex'
      }),
      task,
      taskDeps: undefined,
      bindRunId: () => run.id,
      orchestrationMutation: {
        callerFingerprint: 'home_peer',
        requestId: 'request_unavailable',
        method: 'orchestration.workerStart',
        payloadHash: 'unavailable_payload'
      }
    })

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'remote_attach',
      lastError: 'Codex is not installed on the worker host.',
      effects: [],
      residualResources: []
    })
    const dispatch = db.getDispatchContext(task.id)!
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'failed',
      stage: 'remote_attach',
      last_error: 'Codex is not installed on the worker host.'
    })
    expect(db.getTask(task.id)).toMatchObject({ status: 'failed' })
  })
})
