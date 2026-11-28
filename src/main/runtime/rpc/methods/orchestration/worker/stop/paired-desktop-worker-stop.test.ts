import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY
} from '../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { rendererOrchestrationEnvelope } from '../../../../../../ipc/runtime-environments/connections/runtime-environment-shared-control-envelope'
import {
  createSessionCallerHarness,
  type SessionCallerHarness
} from '../../../../orchestration/callers/session.test-fixture'

// This Orca is computer B, where the bot lives. It placed the worker on computer C, an older paired
// server, so it keeps the worker as a federated Dispatch. The owner presses Stop on a desktop paired
// with B. Only C is faked.
let harness: SessionCallerHarness
let dispatchId: string
const serverC = vi.fn<(method: string, params: unknown, requestId?: string) => unknown>()

beforeEach(() => {
  harness = createSessionCallerHarness({ current: null })
  const task = harness.db.createTask({ runId: 'run_legacy_local', spec: 'prod scan' })
  dispatchId = harness.db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {},
    federation: {
      environmentId: 'env_c',
      environmentName: 'C',
      peerFingerprint: 'peer-c',
      protocolVersion: 3
    }
  }).dispatch.id
  harness.db.reconcileFederatedWorkerStart({
    dispatchId,
    state: 'ready',
    stage: 'remote_input_accepted',
    worktreeId: 'repo::remote',
    terminalHandle: 'term_remote'
  })
  vi.spyOn(harness.runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue({
    environmentId: 'env_c',
    name: 'C',
    peerFingerprint: 'peer-c'
  })
  vi.spyOn(harness.runtime, 'callOrchestrationWorkerServer').mockImplementation(
    async (_server, method, params, _timeout, envelope) =>
      serverC(method, params, envelope?.orchestrationRequestId)
  )
  cStops({})
})

/** C: not kept open, can prove a stop and stop helpers, and stops the worker with `extra`. */
function cStops(extra: Record<string, unknown>): void {
  serverC.mockImplementation((method) =>
    method === 'orchestration.federationShow'
      ? { keptOpen: false }
      : method === 'status.get'
        ? {
            capabilities: [
              ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_STOP_HELPERS_RUNTIME_CAPABILITY
            ]
          }
        : {
            state: 'stopped',
            alreadySettled: false,
            processAction: 'closed_agent_terminal',
            ...extra
          }
  )
}

afterEach(() => {
  serverC.mockReset()
  harness.close()
  vi.restoreAllMocks()
})

/** The stop as the paired desktop's main process puts it on the wire to B. */
async function stopFromPairedDesktop(requestId: string): Promise<unknown> {
  const params = { dispatch: dispatchId }
  const replies: string[] = []
  await harness.dispatcher.dispatchStreaming(
    {
      id: 'rpc-stop',
      authToken: 'device-token',
      method: 'orchestration.workerStop',
      params,
      ...rendererOrchestrationEnvelope('orchestration.workerStop', params, requestId)
    },
    (reply) => replies.push(reply),
    {
      authenticatedCallerFingerprint: 'paired-desktop-credential',
      clientId: 'paired-desktop',
      pairedDeviceId: 'paired-desktop',
      clientKind: 'runtime',
      callerScope: { kind: 'runtime-paired', grants: [] }
    }
  )
  expect(replies).toHaveLength(1)
  return JSON.parse(replies[0]!)
}

it("stops, on C, a worker B placed there when the paired desktop's Stop names a request id", async () => {
  const reply = await stopFromPairedDesktop('desktop-stop-1')
  expect(reply).toMatchObject({ ok: true, result: { dispatchId, state: 'stopped' } })
  expect(serverC).toHaveBeenCalledWith(
    'orchestration.federationStop',
    { dispatchId },
    'desktop-stop-1'
  )
})

// The worker stopped on C, but a helper it started there did not prove it stopped: B says so.
it('passes back a helper under that worker whose stop C could not confirm', async () => {
  cStops({
    helpers: [
      {
        dispatchId: 'ctx_helper_on_c',
        creatorDispatchId: dispatchId,
        outcome: 'unconfirmed',
        lastError: 'The helper terminal is unverifiable.'
      }
    ]
  })
  const reply = await stopFromPairedDesktop('desktop-stop-2')
  expect(reply).toMatchObject({
    ok: true,
    result: {
      state: 'stopped',
      helpers: [
        {
          dispatchId: 'ctx_helper_on_c',
          outcome: 'unconfirmed',
          lastError: 'The helper terminal is unverifiable.'
        }
      ]
    }
  })
})
