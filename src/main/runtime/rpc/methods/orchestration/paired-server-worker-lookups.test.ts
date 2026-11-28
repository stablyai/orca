import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { openRemoteRunLink } from '../../../orchestration/db/remote-owned/remote-run-links'
import {
  adoptRemoteAttempt,
  reserveRemotePlacement
} from '../../../orchestration/db/remote-owned/remote-placements'
import { routeRemoteOwnedCall } from '../../../orchestration/federation/remote-owned/remote-owned-route'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { ORCHESTRATION_CALLER_METHODS } from './caller-show'
import { ORCHESTRATION_WORKER_TRANSCRIPT_METHODS } from './worker/worker-transcript'

const TASK = 'task_0123456789ab'
const DISPATCH = 'ctx_0123456789ab'
let db: OrchestrationDb
const callServer = vi.fn()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookups read only these members.
const runtime = {
  getOrchestrationDb: () => db,
  getTerminalPaneKey: () => null,
  getTerminalHandleForPaneKey: () => null,
  callOrchestrationWorkerServer: callServer
} as unknown as OrcaRuntimeService
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local desktop caller.
const ctx = { runtime } as unknown as RpcContext

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  callServer.mockReset()
  const runId = db.createRun({
    objective: 'o',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  const link = openRemoteRunLink(db, runId, {
    environmentId: 'env_server',
    name: 'Server',
    peerFingerprint: 'fp_server',
    homePeerFingerprint: 'fp_home',
    pairingRevision: 1
  })
  reserveRemotePlacement(db, {
    link,
    taskId: TASK,
    requestKey: 'key',
    create: { spec: 'work' },
    creator: { kind: 'system' }
  })
  adoptRemoteAttempt(db, link, { taskId: TASK, dispatchId: DISPATCH })
})
afterEach(() => db.close())

// Only the paired server knows where its worker runs; this Orca's answer names that server for
// the opener to ask, whichever lookup the opener uses, never a location in the server's own terms.
it.each(['orchestration.partyOpen', 'orchestration.partyLocation'])(
  '%s for a worker a paired server runs names that server',
  async (name) => {
    const method = eraseRpcMethods(ORCHESTRATION_CALLER_METHODS).find((m) => m.name === name)!
    const params = { address: `dispatch:${DISPATCH}` }
    const request = { id: 'r1', authToken: '', method: name, params }
    expect(await routeRemoteOwnedCall(runtime, method, request, params, ctx)).toEqual({
      handled: false
    })
    expect(await method.handler(params, ctx)).toEqual({
      location: null,
      pairedServer: 'env_server'
    })
    expect(callServer).not.toHaveBeenCalled()
  }
)

// A paired server's log path names a file on that server: this computer's read never fetches it to open here.
it('the worker log read for a worker a paired server runs stays on this computer and finds none', async () => {
  const method = eraseRpcMethods(ORCHESTRATION_WORKER_TRANSCRIPT_METHODS)[0]!
  const params = { dispatch: DISPATCH }
  const request = { id: 'r1', authToken: '', method: method.name, params }
  expect(await routeRemoteOwnedCall(runtime, method, request, params, ctx)).toEqual({
    handled: false
  })
  expect(await method.handler(params, ctx)).toEqual({ transcript: null })
  expect(callServer).not.toHaveBeenCalled()
})
