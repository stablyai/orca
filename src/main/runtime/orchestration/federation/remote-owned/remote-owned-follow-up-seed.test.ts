import { afterEach, expect, it } from 'vitest'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../../rpc/core'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import type { OrchestrationWorkerServer } from '../environment-transport'
import {
  adoptRemoteAttempt,
  recordRemoteStart,
  reserveRemotePlacement
} from '../../db/remote-owned/remote-placements'
import { getRemoteDispatch } from '../../db/remote-owned/remote-dispatch-records'
import { openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import { routeRemoteOwnedCall } from './remote-owned-route'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_g16',
  name: 'g16',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const CHAT = testOrcaSessionId('starting-chat')
const db = new OrchestrationDb(':memory:')
afterEach(() => db.close())

it("fills in a follow-up the queue recorded first from the send's answer", async () => {
  const runId = db.createRun({
    objective: 'o',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  const link = openRemoteRunLink(db, runId, SERVER)
  reserveRemotePlacement(db, {
    link,
    taskId: 'task_0123456789ab',
    requestKey: 'k',
    create: { spec: 'w' },
    creator: { kind: 'session', orcaSessionId: CHAT }
  })
  recordRemoteStart(db, {
    conversationId: link.conversation_id,
    taskId: 'task_0123456789ab',
    dispatchId: 'ctx_remote000001',
    requestKey: 'k',
    peerRunId: 'run_peer'
  })
  // An older server's queue item names the follow-up before the send returns, saying nothing else.
  adoptRemoteAttempt(db, link, { taskId: 'task_followup0001', dispatchId: 'ctx_followup00001' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forward reads only these members.
  const runtime = {
    getOrchestrationDb: () => db,
    resolveOrchestrationWorkerServer: async () => SERVER,
    getRuntimeId: () => 'runtime_home',
    readMachineName: () => 'home',
    notifyMessageArrived: () => {},
    callOrchestrationWorkerServer: async () => ({
      dispatchId: 'ctx_followup00001',
      taskId: 'task_followup0001',
      effects: [{ kind: 'worktree', action: 'reused', id: 'repo::/first' }]
    })
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
  await routeRemoteOwnedCall(
    runtime,
    method,
    { id: 'r1', authToken: '', method: 'orchestration.send', params },
    method.params ? method.params.parse(params) : params,
    ctx
  )
  expect(getRemoteDispatch(db, 'ctx_followup00001')).toMatchObject({
    creator_orca_session_id: CHAT,
    worktree_id: 'repo::/first'
  })
})
