import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../../rpc/core'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import type { OrchestrationWorkerServer } from '../environment-transport'
import { OrchestrationError } from '../../orchestration-error'
import { recordRemoteStart, reserveRemotePlacement } from '../../db/remote-owned/remote-placements'
import { openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { routeRemoteOwnedCall } from './remote-owned-route'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_g16',
  name: 'g16',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const db = new OrchestrationDb(':memory:')
afterEach(() => db.close())

it('names the paired server when it refuses a follow-up for an agent it lacks', async () => {
  const runId = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: null
  }).id
  const link = openRemoteRunLink(db, runId, SERVER)
  reserveRemotePlacement(db, {
    link,
    taskId: 'task_0123456789ab',
    requestKey: 'k',
    create: { spec: 'w' }
  })
  recordRemoteStart(db, {
    conversationId: link.conversation_id,
    taskId: 'task_0123456789ab',
    dispatchId: 'ctx_remote000001',
    requestKey: 'k',
    peerRunId: 'run_peer'
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forward reads only these members.
  const runtime = {
    getOrchestrationDb: () => db,
    resolveOrchestrationWorkerServer: async () => SERVER,
    getRuntimeId: () => 'runtime_home',
    readMachineName: () => 'home',
    notifyMessageArrived: () => {},
    // The server's own refusal, worded where it ran.
    callOrchestrationWorkerServer: async () => {
      throw new OrchestrationError(
        'worker_agent_unavailable',
        "Codex isn't installed on this computer, so no worker was started there.",
        { effectsApplied: false, agent: 'codex', reason: 'not_installed' }
      )
    }
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local CLI caller.
  const ctx = { runtime } as unknown as RpcContext
  const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
    (candidate) => candidate.name === 'orchestration.send'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('orchestration.send is a plain method')
  }
  const params = {
    from: 'term_coord',
    to: 'dispatch:ctx_remote000001',
    subject: 'more',
    body: 'one more thing',
    type: 'dispatch'
  }
  const refused = await routeRemoteOwnedCall(
    runtime,
    method,
    { id: 'r1', authToken: '', method: 'orchestration.send', params },
    method.params ? method.params.parse(params) : params,
    ctx
  ).catch((error: unknown) => error)
  expect(refused).toMatchObject({
    code: 'worker_agent_unavailable',
    message: expect.stringContaining("Codex isn't installed on g16")
  })
})
