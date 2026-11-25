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

// The worker's own process is the only fake: fence and settle run on the real database, and each
// stop that got past the fence counts one kill.
const kills = vi.hoisted(() => vi.fn<(dispatchId: string) => void>())
vi.mock('./worker/stop/single-worker-stop', () => ({
  stopSingleWorker: async (
    runtime: { getOrchestrationDb: () => OrchestrationDb },
    dispatchId: string
  ) => {
    const db = runtime.getOrchestrationDb()
    const begun = db.beginWorkerStop(dispatchId, 'epoch_1')
    if (begun.disposition !== 'stopping') {
      return { dispatchId, state: 'stopped', alreadySettled: true, processAction: 'none' }
    }
    kills(dispatchId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    db.settleWorkerStop(dispatchId)
    return {
      dispatchId,
      state: 'stopped',
      alreadySettled: false,
      processAction: 'closed_agent_terminal'
    }
  }
}))
vi.mock('./worker/release/worker-bound-terminal-close', () => ({
  closeStoppedWorkerTerminals: async () => {}
}))

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

type OwnerParams = {
  party: string
  dispatch: string
  requestId: string
  settlements: { dispatchId: string; settlement: string }[]
  acknowledged: boolean
}

const ownerParams: OwnerParams = {
  party: 'orca_session_id:11111111-1111-4111-8111-111111111111',
  dispatch: 'ctx_unknown',
  requestId: 'stop-request',
  settlements: [],
  acknowledged: true
}

/** Runs a dock owner action as the given caller. */
async function ownerAction(
  name: 'orchestration.workerDockAcknowledge' | 'orchestration.workerDockStop',
  ctx: RpcContext,
  params: OwnerParams = ownerParams
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
  vi.spyOn(db, 'getFederatedDispatch').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only test that a row exists.
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

it('stops a worker once for a double-clicked and then retried dock Stop', async () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Verify journal writes' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  db.db
    .prepare(
      "UPDATE dispatch_contexts SET creator_orca_session_id = '11111111-1111-4111-8111-111111111111' WHERE id = ?"
    )
    .run(dispatch.id)
  db.db
    .prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?")
    .run(dispatch.id)
  const ctx = ownerContext(db, {
    caller: { kind: 'paired-device', deviceId: 'paired-phone' },
    clientKind: 'mobile'
  })
  const press = (requestId: string) =>
    ownerAction('orchestration.workerDockStop', ctx, {
      ...ownerParams,
      dispatch: dispatch.id,
      requestId
    })

  const [first, second] = await Promise.all([press('click-1'), press('click-2')])
  const retried = await press('click-1')

  expect(kills).toHaveBeenCalledTimes(1)
  expect(first).toMatchObject({ state: 'stopped', alreadySettled: false })
  expect(second).toBe(first)
  expect(retried).toMatchObject({ state: 'stopped', alreadySettled: true })
  expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopped')
})
