import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RpcContext } from '../../core'
import type { RpcCallerIdentity } from '../../callers/rpc-caller-identity'
import { ORCHESTRATION_WORKER_DOCK_METHODS } from './worker-dock-methods'
import {
  ORCHESTRATION_PAIRED_WORKER_DOCK_OWNER_RUNTIME_CAPABILITY,
  ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from '../../../../../shared/remote-runtime/protocol/protocol-version'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('refuses stop or acknowledgment from the CLI, an agent, or a paired client that is not a person', async () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const callers: (RpcCallerIdentity | undefined)[] = [
    undefined,
    { kind: 'local-cli' },
    { kind: 'paired-device', deviceId: 'paired-desktop' },
    { kind: 'paired-device', deviceId: 'paired-agent', agent: true }
  ]
  const params = {
    party: 'orca_session_id:11111111-1111-4111-8111-111111111111',
    dispatch: 'ctx_unknown',
    requestId: 'stop-request',
    settlements: [],
    acknowledged: true
  }
  for (const caller of callers) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only need the DB after the caller guard.
    const ctx = { runtime: { getOrchestrationDb: () => db }, caller } as RpcContext
    for (const method of ORCHESTRATION_WORKER_DOCK_METHODS) {
      if (
        method.name === 'orchestration.workerDockStop' ||
        method.name === 'orchestration.workerDockAcknowledge'
      ) {
        await expect(async () => method.handler(params, ctx)).rejects.toMatchObject({
          code: 'owner_required'
        })
      }
    }
  }
})

const ownerParams = {
  party: 'orca_session_id:11111111-1111-4111-8111-111111111111',
  dispatch: 'ctx_unknown',
  requestId: 'stop-request',
  settlements: [] as { dispatchId: string; settlement: string }[],
  acknowledged: true
}

/** Runs a dock owner action as the given caller. */
async function ownerAction(
  name: 'orchestration.workerDockAcknowledge' | 'orchestration.workerDockStop',
  ctx: RpcContext,
  params = ownerParams
): Promise<unknown> {
  for (const method of ORCHESTRATION_WORKER_DOCK_METHODS) {
    if (method.name === 'orchestration.workerDockAcknowledge' && method.name === name) {
      return method.handler(params, ctx)
    }
    if (method.name === 'orchestration.workerDockStop' && method.name === name) {
      return method.handler(params, ctx)
    }
  }
  throw new Error(name)
}

function ownerContext(db: OrchestrationDb, ctx: Partial<RpcContext>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only need the DB after the caller guard.
  return { runtime: { getOrchestrationDb: () => db }, ...ctx } as RpcContext
}

it('lets a person on a paired window or phone Clear and Stop from the dock', async () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const people: Partial<RpcContext>[] = [
    {
      caller: { kind: 'paired-device', deviceId: 'paired-desktop' },
      clientCapabilities: [ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY]
    },
    {
      caller: { kind: 'paired-device', deviceId: 'paired-phone' },
      clientKind: 'mobile'
    }
  ]
  for (const person of people) {
    const ctx = ownerContext(db, person)
    await expect(ownerAction('orchestration.workerDockAcknowledge', ctx)).resolves.toEqual({
      acknowledged: true
    })
    // Past the owner check: the unknown worker is what refuses it.
    await expect(ownerAction('orchestration.workerDockStop', ctx)).rejects.toMatchObject({
      code: 'dispatch_not_found'
    })
  }
})

it("refuses an agent's or a paired Orca's call even when it says it is a person's window", async () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const agents: Partial<RpcContext>[] = [
    {
      caller: { kind: 'paired-device', deviceId: 'paired-agent', agent: true },
      clientCapabilities: [ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY]
    },
    {
      caller: { kind: 'paired-device', deviceId: 'paired-orca' },
      clientCapabilities: [ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only its presence is read.
      orchestrationCaller: {} as RpcContext['orchestrationCaller']
    }
  ]
  for (const agent of agents) {
    const ctx = ownerContext(db, agent)
    for (const name of [
      'orchestration.workerDockAcknowledge',
      'orchestration.workerDockStop'
    ] as const) {
      await expect(ownerAction(name, ctx)).rejects.toMatchObject({
        code: 'owner_required'
      })
    }
  }
})

it('tells paired clients it takes Clear and Stop from a person on them', () => {
  expect(RUNTIME_CAPABILITIES).toContain(ORCHESTRATION_PAIRED_WORKER_DOCK_OWNER_RUNTIME_CAPABILITY)
})

it("refuses a paired person's Clear and Stop of a worker that runs on another computer", async () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only test that a row exists.
  vi.spyOn(db, 'getFederatedDispatch').mockReturnValue(
    {} as ReturnType<OrchestrationDb['getFederatedDispatch']>
  )
  const ctx = ownerContext(db, {
    caller: { kind: 'paired-device', deviceId: 'paired-desktop' },
    clientCapabilities: [ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY]
  })
  const params = {
    ...ownerParams,
    settlements: [{ dispatchId: 'ctx_unknown', settlement: 'settlement-1' }]
  }
  for (const name of [
    'orchestration.workerDockAcknowledge',
    'orchestration.workerDockStop'
  ] as const) {
    await expect(ownerAction(name, ctx, params)).rejects.toMatchObject({
      code: 'remote_owner_actions_unsupported'
    })
  }
})
