import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY
} from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { isDurableMutation } from '../../../shared/orchestration/orchestration-rpc-contract'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { ORCHESTRATION_METHODS } from './methods/orchestration/orchestration'

const TERMINAL = 'term_coord'
const TERMINAL_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER = 'term_worker'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function pairedClient(fingerprint: string): RpcDispatchStreamingOptions {
  return {
    clientKind: 'runtime',
    pairedDeviceId: `device_${fingerprint}`,
    authenticatedCallerFingerprint: fingerprint,
    clientCapabilities: [ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY],
    callerScope: { kind: 'runtime-paired', grants: [] }
  }
}

let sequence = 0
const dbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

function createHarness() {
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === TERMINAL ? TERMINAL_PANE : handle === WORKER ? WORKER_PANE : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle.startsWith('term_') ? `runtime_test:${handle}:1` : null
  )
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  const call = async (
    method: string,
    params: Record<string, unknown>,
    options?: RpcDispatchStreamingOptions,
    extra: Partial<RpcRequest> = {}
  ): Promise<RpcResponse> => {
    sequence += 1
    return await dispatcher.dispatch(
      {
        id: `rpc_external_${sequence}`,
        authToken: 'test-token',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        ...(isDurableMutation(method, params) ? { orchestrationRequestId: `ext_${sequence}` } : {}),
        ...extra
      },
      options
    )
  }
  const result = async <T>(response: Promise<RpcResponse>): Promise<T> => {
    const settled = await response
    if (!settled.ok) {
      throw new Error(`${settled.error.code}: ${settled.error.message}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the result shape of the method it dispatched.
    return settled.result as T
  }
  return { db, call, result }
}

describe('external coordinator over a paired runtime client', () => {
  it('runs the coordinator loop with no terminal handle', async () => {
    const { db, call, result } = createHarness()
    const daemon = pairedClient('fp_daemon')
    const { run } = await result<{ run: { id: string; consumer_generation: number } }>(
      call('orchestration.runCreate', { objective: 'Nightly bumps', external: true }, daemon)
    )
    expect(db.getRun(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null
    })
    expect(await result(call('orchestration.runCurrent', {}, daemon))).toMatchObject({
      run: { id: run.id }
    })
    // Another paired device sees no Run of its own.
    expect(await result(call('orchestration.runCurrent', {}, pairedClient('fp_other')))).toEqual({
      run: null
    })

    const { task } = await result<{ task: { id: string; run_id: string } }>(
      call('orchestration.taskCreate', { spec: 'Bump eslint' }, daemon)
    )
    expect(task.run_id).toBe(run.id)
    const { gate } = await result<{ gate: { id: string } }>(
      call('orchestration.gateCreate', { task: task.id, question: 'Ship?' }, daemon)
    )
    expect(await result(call('orchestration.gateList', {}, daemon))).toMatchObject({
      runId: run.id,
      count: 1
    })
    await result(call('orchestration.gateResolve', { id: gate.id, resolution: 'yes' }, daemon))

    const waiting = result<{ messages: { id: string; subject: string }[]; deliveryId: string }>(
      call('orchestration.check', { wait: true, timeoutMs: 5_000 }, daemon)
    )
    await result(
      call('orchestration.send', { from: WORKER, to: `run:${run.id}`, subject: 'eslint done' })
    )
    const delivered = await waiting
    expect(delivered.messages.map((message) => message.subject)).toEqual(['eslint done'])

    const { message: reply } = await result<{
      message: { to_handle: string; from_handle: string }
    }>(call('orchestration.reply', { id: delivered.messages[0].id, body: 'thanks' }, daemon))
    expect(reply).toMatchObject({ to_handle: WORKER, from_handle: `run:${run.id}` })
    expect(
      await result(call('orchestration.check', { ack: delivered.deliveryId }, daemon))
    ).toMatchObject({ acknowledged: delivered.deliveryId })

    const { dispatch } = await result<{ dispatch: { id: string; run_id: string } }>(
      call('orchestration.dispatch', { task: task.id, to: WORKER }, daemon)
    )
    expect(dispatch.run_id).toBe(run.id)
    const { message: sent } = await result<{ message: { from_handle: string } }>(
      call('orchestration.send', { to: `dispatch:${dispatch.id}`, subject: 'rebase first' }, daemon)
    )
    expect(sent.from_handle).toBe(`run:${run.id}`)
  })

  it('fences the external coordinator when a terminal binds its Run', async () => {
    const { call, result } = createHarness()
    const daemon = pairedClient('fp_daemon')
    const { run } = await result<{ run: { id: string } }>(
      call('orchestration.runCreate', { objective: 'Hand over', external: true }, daemon)
    )
    const waiting = call('orchestration.check', { wait: true, timeoutMs: 5_000 }, daemon)
    await result(call('orchestration.runUse', { id: run.id, from: TERMINAL }))

    expect(await waiting).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(await call('orchestration.check', {}, daemon)).toMatchObject({
      ok: false,
      error: { code: 'run_required' }
    })
    expect(await call('orchestration.check', { run: run.id }, daemon)).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
    expect(await result(call('orchestration.runCurrent', { from: TERMINAL }))).toMatchObject({
      run: { id: run.id }
    })
  })

  it('partitions mutation replay by client, Run and consumer generation', async () => {
    const { call, result } = createHarness()
    const create = (fingerprint: string) =>
      result<{ run: { id: string } }>(
        call(
          'orchestration.runCreate',
          { objective: 'Replay', external: true },
          pairedClient(fingerprint),
          { orchestrationRequestId: 'same_request' }
        )
      )
    const first = await create('fp_a')
    expect(await create('fp_a')).toMatchObject({
      run: { id: first.run.id },
      mutation: { replayed: true }
    })
    expect((await create('fp_b')).run.id).not.toBe(first.run.id)
  })

  it('refuses external authority to phones, unnegotiated clients and Orca-launched agents', async () => {
    const { call } = createHarness()
    const refused = { ok: false, error: { code: 'external_coordinator_unsupported' } }
    const params = { objective: 'Not allowed', external: true }
    expect(
      await call('orchestration.runCreate', params, {
        ...pairedClient('fp_phone'),
        clientKind: 'mobile',
        callerScope: undefined
      })
    ).toMatchObject(refused)
    expect(
      await call('orchestration.runCreate', params, {
        ...pairedClient('fp_old'),
        clientCapabilities: []
      })
    ).toMatchObject(refused)
    expect(await call('orchestration.runCreate', params)).toMatchObject(refused)
    expect(
      await call('orchestration.runCreate', params, pairedClient('fp_worker'), {
        orchestrationCompatibilityEvidence: { terminalHandle: WORKER, paneKey: WORKER_PANE }
      })
    ).toMatchObject(refused)
  })

  it('needs an existing workspace for worker-start', async () => {
    const { call, result } = createHarness()
    const daemon = pairedClient('fp_daemon')
    await result(call('orchestration.runCreate', { objective: 'Workers', external: true }, daemon))
    expect(
      await call('orchestration.workerStart', { spec: 'Bump eslint', agent: 'codex' }, daemon)
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('--worktree') }
    })
  })
})
