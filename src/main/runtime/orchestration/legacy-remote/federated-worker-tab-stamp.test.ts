import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db/orchestration-db'
import { FederationAttachStartParams } from '../../../../shared/rpc-contract/orchestration/orchestration-federation-start-params'
import { workerTabStampForFederatedStart } from './federated-worker-tab-stamp'
import { stopSingleWorker } from '../../rpc/methods/orchestration/worker/stop/single-worker-stop'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})
const wire = {
  runId: 'run-home',
  dispatchId: 'ctx_remote',
  taskId: 'task_remote',
  taskSpec: 'Review remote changes',
  protocolVersion: 3,
  worktree: 'id:repo::windows-worktree',
  agent: 'codex',
  repo: 'id:windows-repo',
  workerTab: {
    origin: {
      runId: 'run-home',
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      taskTitle: 'Review remote changes',
      parent: { kind: 'session', lineageRootSessionId: 'helper-root' },
      coordinator: { kind: 'session', lineageRootSessionId: 'coordinator-root' }
    }
  }
}

it.each([1, 3])(
  'refuses a receiver-only CLI stop before effects (protocol %s)',
  async (protocolVersion) => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const close = vi.spyOn(runtime, 'closeTerminal')
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'home-peer',
      protocolVersion,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home-peer',
        requestId: 'request-remote',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash-remote'
      }
    })
    await expect(stopSingleWorker(runtime, 'ctx_remote', undefined)).rejects.toMatchObject({
      code: 'worker_stop_remote_origin'
    })
    expect(close).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment('ctx_remote')?.state).toBe('starting')
  }
)

it('keeps old-host and terminal-takeover surfaces unstamped', () => {
  expect(
    workerTabStampForFederatedStart(
      FederationAttachStartParams.parse({ ...wire, workerTab: undefined })
    )
  ).toBeUndefined()
  expect(
    workerTabStampForFederatedStart(
      FederationAttachStartParams.parse({ ...wire, terminal: 'term_user' })
    )
  ).toBeUndefined()
  expect(
    workerTabStampForFederatedStart(
      FederationAttachStartParams.parse({ ...wire, dispatchId: 'ctx_other' })
    )
  ).toBeUndefined()
})
