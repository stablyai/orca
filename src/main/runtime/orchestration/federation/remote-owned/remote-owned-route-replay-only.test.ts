import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RpcContext, RpcMethod, RpcRequest } from '../../../rpc/core'
import type { OrcaRuntimeService } from '../../../orca-runtime'

const { callRemoteOwnedServerMock } = vi.hoisted(() => ({
  callRemoteOwnedServerMock: vi.fn(async () => ({ ok: true }))
}))

// One remote-owned Dispatch on an open link; the forward itself is observed, never sent.
vi.mock('../../db/remote-owned/remote-dispatch-records', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRemoteDispatch: (_db: unknown, dispatchId: string) =>
    dispatchId === 'ctx_remote'
      ? { dispatch_id: 'ctx_remote', conversation_id: 'conv_1' }
      : undefined,
  getRemoteOwnedQuestion: () => undefined
}))
vi.mock('../../db/remote-owned/remote-run-links', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRemoteRunLink: () => ({ conversation_id: 'conv_1', environment_id: 'env_1', state: 'open' })
}))
vi.mock(
  '../../../rpc/methods/orchestration/access/orchestration-method-access',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    checkDeclaredOrchestrationAccess: () => undefined
  })
)
vi.mock('./remote-forward-caller', () => ({
  remoteForwardKey: (_runtime: unknown, _ctx: unknown, _caller: unknown, requestId?: string) =>
    requestId ? { key: `forward_${requestId}`, requestId } : undefined
}))
vi.mock('./remote-owned-reads', () => ({
  remoteServerName: async () => 'server',
  remoteWorkerShow: async () => ({})
}))
vi.mock('./remote-owned-calls', () => ({ callRemoteOwnedServer: callRemoteOwnedServerMock }))

import { routeRemoteOwnedCall } from './remote-owned-route'

const SEND_METHOD = {
  name: 'orchestration.send',
  orchestrationAccess: {
    kind: 'writes',
    caller: 'from',
    callerPane: 'senderPaneKey',
    server: 'on',
    targets: { to: 'party', threadId: 'message', run: 'run', payload: 'dispatch' }
  }
}

const params = { from: 'term_coord', to: 'dispatch:ctx_remote', subject: 'Go on', type: 'status' }

function route(contractVersion: number) {
  const request: RpcRequest = {
    id: 'rpc_1',
    authToken: 'token',
    method: 'orchestration.send',
    params,
    orchestrationContractVersion: contractVersion,
    orchestrationRequestId: 'mutation_1'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route reads only the database handle, which the mocked lookups ignore.
  const runtime = { getOrchestrationDb: () => ({}) } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route reads only orchestrationAccess from the method.
  const method = SEND_METHOD as unknown as RpcMethod
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local caller; access checks are mocked.
  const ctx = {} as RpcContext
  return routeRemoteOwnedCall(runtime, method, request, params, ctx)
}

describe('a replay-only retry about a worker a paired server owns', () => {
  beforeEach(() => {
    callRemoteOwnedServerMock.mockClear()
  })

  it('is refused before forwarding, since the forward would run as new work there', async () => {
    await expect(route(ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION)).rejects.toMatchObject({
      code: 'retry_not_replayable',
      data: { requestId: 'mutation_1', reason: 'route_keeps_no_receipt', effectsApplied: false }
    })
    expect(callRemoteOwnedServerMock).not.toHaveBeenCalled()
  })

  it('leaves an ordinary request forwarded as before', async () => {
    await expect(route(ORCHESTRATION_CONTRACT_VERSION)).resolves.toMatchObject({ handled: true })
    expect(callRemoteOwnedServerMock).toHaveBeenCalledTimes(1)
  })
})
