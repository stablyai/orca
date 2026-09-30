import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_RECONCILE_ATTACHMENT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcRequest } from '../../../core'
import { OrchestrationMutationExecutor } from '../../../orchestration-mutation-executor'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from './worker-control'
import { ORCHESTRATION_WORKER_RECONCILE_ATTACHMENT_METHODS } from './worker-reconcile-attachment'
import { ORCHESTRATION_WORKER_STOP_METHODS } from './worker-stop'

const CAPABILITY = ORCHESTRATION_FEDERATION_RECONCILE_ATTACHMENT_RUNTIME_CAPABILITY
const DISPATCH = 'ctx_home_abandoned'
const HANDLE = 'term_saved'
const PANE = 'tab_saved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INCARNATION = 'runtime:pty:saved'
const EPOCH = 'epoch-remote'

describe('home attachment reconcile', () => {
  function harness(options?: {
    workerState?: string
    federated?: boolean
    peerFingerprint?: string
    show?: Record<string, unknown>
    reconcile?: () => unknown
  }) {
    const calls: string[] = []
    const db = {
      getDispatchContextById: () => ({ id: DISPATCH }),
      getWorkerDispatch: () =>
        options?.workerState === 'missing' ? undefined : { state: options?.workerState ?? 'abandoned' },
      getFederatedDispatch: () =>
        options?.federated === false
          ? undefined
          : {
              dispatch_id: DISPATCH,
              environment_id: 'env-work',
              environment_name: 'work',
              peer_fingerprint: 'peer-work',
              remote_runtime_epoch: EPOCH,
              remote_terminal_handle: HANDLE
            },
      beginWorkerStop: vi.fn(() => ({
        disposition: 'already_settled',
        worker: { state: 'abandoned' }
      })),
      abandonWorkerDispatch: () => ({
        disposition: 'abandoned',
        worker: { state: 'abandoned', residual_resources: '[]' }
      })
    }
    const callOrchestrationWorkerServer = vi.fn(async (_environment, method: string) => {
      calls.push(method)
      if (method === 'status.get') {
        return { capabilities: [CAPABILITY] }
      }
      if (method === 'orchestration.federationShow') {
        return (
          options?.show ?? {
            runtimeEpoch: EPOCH,
            attachment: {
              state: 'ready',
              terminal_handle: HANDLE,
              pane_key: PANE,
              process_incarnation: INCARNATION,
              runtime_epoch: EPOCH
            },
            terminal: { handle: HANDLE },
            observation: { status: 'live', exactWorker: true }
          }
        )
      }
      if (method === 'orchestration.federationReconcileAttachment') {
        return options?.reconcile ? options.reconcile() : {
          dispatchId: DISPATCH,
          state: 'abandoned',
          alreadyReconciled: false,
          processAction: 'none'
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    const runtime = {
      getOrchestrationDb: () => db,
      getRuntimeId: () => 'runtime-home',
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'env-work',
        name: 'work',
        peerFingerprint: options?.peerFingerprint ?? 'peer-work',
        pairingRevision: 7
      }),
      callOrchestrationWorkerServer,
      notifyMessageArrived: vi.fn(),
      forgetStructuredSessionMail: vi.fn()
    } as unknown as OrcaRuntimeService
    return { runtime, calls, callOrchestrationWorkerServer }
  }

  async function reconcile(
    runtime: OrcaRuntimeService,
    requestId = 'request-reconcile'
  ) {
    const method = ORCHESTRATION_WORKER_RECONCILE_ATTACHMENT_METHODS[0]!
    return method.handler(method.params!.parse({ dispatch: DISPATCH }), {
      runtime,
      orchestrationMutation: {
        callerFingerprint: 'coordinator',
        requestId,
        method: 'orchestration.workerReconcileAttachment',
        payloadHash: 'hash'
      }
    })
  }

  it('refuses a call that has no durable retry identity', async () => {
    const { runtime, callOrchestrationWorkerServer } = harness()
    const method = ORCHESTRATION_WORKER_RECONCILE_ATTACHMENT_METHODS[0]!

    await expect(
      method.handler(method.params!.parse({ dispatch: DISPATCH }), { runtime } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callOrchestrationWorkerServer).not.toHaveBeenCalled()
  })

  it('keeps abandon local', async () => {
    const { runtime, callOrchestrationWorkerServer } = harness()
    const method = ORCHESTRATION_WORKER_CONTROL_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerAbandon'
    )!

    await method.handler(method.params!.parse({ dispatch: DISPATCH }), { runtime } as never)

    expect(callOrchestrationWorkerServer).not.toHaveBeenCalled()
  })

  it('does not remove the settled stop guard', async () => {
    const { runtime, callOrchestrationWorkerServer } = harness()
    const method = ORCHESTRATION_WORKER_STOP_METHODS[0]!

    await expect(
      method.handler(method.params!.parse({ dispatch: DISPATCH }), {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request-stop',
          method: 'orchestration.workerStop',
          payloadHash: 'hash'
        }
      })
    ).resolves.toMatchObject({ state: 'abandoned', alreadySettled: true, processAction: 'none' })
    expect(callOrchestrationWorkerServer).not.toHaveBeenCalled()
  })

  it('sends the saved terminal identity and never a stop', async () => {
    const { runtime, calls, callOrchestrationWorkerServer } = harness()

    await expect(reconcile(runtime)).resolves.toMatchObject({
      state: 'abandoned',
      processAction: 'none',
      alreadyReconciled: false
    })
    expect(calls).toEqual([
      'status.get',
      'orchestration.federationShow',
      'orchestration.federationReconcileAttachment'
    ])
    expect(callOrchestrationWorkerServer.mock.calls[2]?.[2]).toEqual({
      dispatchId: DISPATCH,
      expectedRuntimeEpoch: EPOCH,
      expectedTerminalHandle: HANDLE,
      expectedPaneKey: PANE,
      expectedProcessIncarnation: INCARNATION
    })
    expect(calls).not.toContain('orchestration.federationStop')
    expect(calls).not.toContain('orchestration.reset')
  })

  it('does not call the remote mutate method without the capability', async () => {
    const { runtime, callOrchestrationWorkerServer } = harness()
    callOrchestrationWorkerServer.mockImplementation(async (_environment, method: string) => {
      if (method === 'status.get') {
        return { capabilities: [] }
      }
      throw new Error(`unexpected ${method}`)
    })

    await expect(reconcile(runtime)).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(callOrchestrationWorkerServer).toHaveBeenCalledTimes(1)
  })

  it('treats method_not_found as no effect', async () => {
    const { runtime, callOrchestrationWorkerServer } = harness()
    callOrchestrationWorkerServer.mockImplementation(async (_environment, method: string) => {
      if (method === 'status.get') {
        return { capabilities: [CAPABILITY] }
      }
      if (method === 'orchestration.federationShow') {
        return {
          runtimeEpoch: EPOCH,
          attachment: {
            state: 'ready',
            terminal_handle: HANDLE,
            pane_key: PANE,
            process_incarnation: INCARNATION,
            runtime_epoch: EPOCH
          },
          terminal: { handle: HANDLE },
          observation: { status: 'live', exactWorker: true }
        }
      }
      throw new OrchestrationError('method_not_found', 'missing')
    })

    await expect(reconcile(runtime)).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(callOrchestrationWorkerServer.mock.calls.map((call) => call[1])).not.toContain(
      'orchestration.federationStop'
    )
  })

  it('reports a dropped mutate response as uncertain and converges on retry', async () => {
    let committed = false
    const { runtime } = harness({
      reconcile: () => {
        if (!committed) {
          committed = true
          throw new Error('connection dropped')
        }
        return {
          dispatchId: DISPATCH,
          state: 'abandoned',
          alreadyReconciled: true,
          processAction: 'none'
        }
      }
    })

    await expect(reconcile(runtime, 'request-same')).rejects.toMatchObject({
      code: 'reconcile_unknown'
    })
    await expect(reconcile(runtime, 'request-same')).resolves.toMatchObject({
      alreadyReconciled: true,
      processAction: 'none'
    })
  })

  it('refuses an old peer and a non-abandoned worker before any remote call', async () => {
    const oldPeer = harness({ peerFingerprint: 'peer-replaced' })
    await expect(reconcile(oldPeer.runtime)).rejects.toMatchObject({ code: 'peer_changed' })
    expect(oldPeer.callOrchestrationWorkerServer).not.toHaveBeenCalled()

    const active = harness({ workerState: 'ready' })
    await expect(reconcile(active.runtime)).rejects.toMatchObject({ code: 'not_abandoned' })
    expect(active.callOrchestrationWorkerServer).not.toHaveBeenCalled()
  })

  it('does not mutate when the saved epoch or liveness does not match', async () => {
    const epoch = harness({
      show: {
        runtimeEpoch: 'epoch-other',
        attachment: {
          state: 'ready',
          terminal_handle: HANDLE,
          pane_key: PANE,
          process_incarnation: INCARNATION,
          runtime_epoch: 'epoch-other'
        },
        terminal: { handle: HANDLE },
        observation: { status: 'live', exactWorker: true }
      }
    })
    await expect(reconcile(epoch.runtime)).rejects.toMatchObject({
      code: 'runtime_epoch_mismatch'
    })
    expect(epoch.calls).not.toContain('orchestration.federationReconcileAttachment')

    const dark = harness({
      show: {
        runtimeEpoch: EPOCH,
        attachment: {
          state: 'ready',
          terminal_handle: HANDLE,
          pane_key: PANE,
          process_incarnation: INCARNATION,
          runtime_epoch: EPOCH
        },
        terminal: { handle: HANDLE },
        observation: { status: 'unverifiable', exactWorker: true }
      }
    })
    await expect(reconcile(dark.runtime)).rejects.toMatchObject({ code: 'unverifiable' })
    expect(dark.calls).not.toContain('orchestration.federationReconcileAttachment')
  })

  it('retries a reused attachment without requiring it to still be live', async () => {
    const { runtime, calls } = harness({
      show: {
        runtimeEpoch: 'epoch-later',
        attachment: {
          state: 'abandoned',
          capability_hash: null,
          terminal_handle: 'term_other',
          pane_key: PANE,
          process_incarnation: INCARNATION,
          runtime_epoch: 'epoch-later'
        },
        terminal: null,
        observation: { status: 'identity_changed', exactWorker: false }
      },
      reconcile: () => ({
        dispatchId: DISPATCH,
        state: 'abandoned',
        alreadyReconciled: true,
        processAction: 'none'
      })
    })

    await expect(reconcile(runtime)).resolves.toMatchObject({
      alreadyReconciled: true,
      processAction: 'none'
    })
    expect(calls).toContain('orchestration.federationReconcileAttachment')
    expect(calls).not.toContain('orchestration.federationStop')
  })

  it('does not cache a lost reconcile receipt in the mutation dispatcher', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    db.db
      .prepare(`INSERT INTO tasks (id, spec, status) VALUES ('task_home', 'work', 'failed')`)
      .run()
    db.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, status) VALUES ('ctx_home_abandoned', 'task_home', 'failed')`
      )
      .run()
    db.db
      .prepare(
        `INSERT INTO worker_dispatches (dispatch_id, state, stage) VALUES ('ctx_home_abandoned', 'abandoned', 'abandoned')`
      )
      .run()
    db.db
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint,
           remote_runtime_epoch, remote_terminal_handle
         ) VALUES ('ctx_home_abandoned', 'env-work', 'work', 'peer-work', ?, ?)`
      )
      .run(EPOCH, HANDLE)
    let committed = false
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'env-work',
      name: 'work',
      peerFingerprint: 'peer-work',
      pairingRevision: 7
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(async (_environment, method) => {
      if (method === 'status.get') {
        return { capabilities: [CAPABILITY] }
      }
      if (method === 'orchestration.federationShow') {
        return {
          runtimeEpoch: EPOCH,
          attachment: {
            state: committed ? 'abandoned' : 'ready',
            capability_hash: committed ? null : 'hash',
            terminal_handle: HANDLE,
            pane_key: PANE,
            process_incarnation: INCARNATION,
            runtime_epoch: EPOCH
          },
          terminal: { handle: HANDLE },
          observation: { status: 'live', exactWorker: true }
        }
      }
      if (!committed) {
        committed = true
        throw new Error('connection dropped after commit')
      }
      return {
        dispatchId: DISPATCH,
        state: 'abandoned',
        alreadyReconciled: true,
        processAction: 'none'
      }
    })
    const executor = new OrchestrationMutationExecutor(runtime)
    const params = { dispatch: DISPATCH }
    const request = {
      id: 'rpc-request-same',
      authToken: 'token',
      method: 'orchestration.workerReconcileAttachment',
      orchestrationRequestId: 'request-same',
      params
    } as RpcRequest
    const method = ORCHESTRATION_WORKER_RECONCILE_ATTACHMENT_METHODS[0]!
    const invoke = () =>
      method.handler(method.params!.parse(params), {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request-same',
          method: 'orchestration.workerReconcileAttachment',
          payloadHash: 'hash'
        }
      })

    await expect(executor.run(request, params, invoke)).rejects.toMatchObject({
      code: 'reconcile_unknown'
    })
    expect(
      db.getMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), 'request-same')
    ).toBeUndefined()
    await expect(executor.run(request, params, invoke)).resolves.toMatchObject({
      alreadyReconciled: true,
      processAction: 'none'
    })
    db.close()
  })
})
