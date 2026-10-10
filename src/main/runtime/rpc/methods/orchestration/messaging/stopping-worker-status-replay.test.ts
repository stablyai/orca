import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createOrchestrationRpcHarness, type OrchestrationRpcState } from '../rpc-test-harness'
import { startRpcWorker, WORKER_PANE } from '../rpc-worker-authority-test-fixture'

describe('stopping worker status receipt recovery', () => {
  const h = createOrchestrationRpcHarness()
  let s: OrchestrationRpcState
  let runId: string
  let worker: ReturnType<typeof startRpcWorker>

  function bindWorkerPane(runtime: OrcaRuntimeService) {
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE : handle === 'term_coord' ? h.coordinatorPaneKey : null
    )
  }

  beforeEach(() => {
    s = h.setup()
    runId = s.activeRunId!
    bindWorkerPane(s.runtime)
    worker = startRpcWorker(s.db, runId)
  })

  afterEach(() => {
    s.runtime.cancelMessageWaiters(`run:${runId}`)
    h.cleanup()
  })

  function request(requestId: string, params: Record<string, unknown>): RpcRequest {
    return {
      id: `${requestId}_first`,
      authToken: 'test-token',
      method: 'orchestration.send',
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId
    }
  }

  function storedReceipt(requestId: string) {
    return s.db.getMutationReceipt(s.db.getOrCreateLocalMutationCallerFingerprint(), requestId)
  }

  it.each(['warm', 'reconstructed'] as const)(
    'keeps an interrupted suppressed status silent on a %s retry',
    async (retryMode) => {
      s.db.beginWorkerStop(worker.dispatchId, 'owned-test-epoch')
      const firstDispatcher = new RpcDispatcher({
        runtime: s.runtime,
        methods: ORCHESTRATION_METHODS
      })
      const send = request(`stopping_status_${retryMode}`, {
        from: 'term_worker',
        type: 'status',
        subject: 'Stopping worker status',
        payload: JSON.stringify(worker)
      })
      const complete = s.db.completeMutationReceipt.bind(s.db)
      const persist = vi
        .spyOn(s.db, 'completeMutationReceipt')
        .mockImplementationOnce(complete)
        .mockImplementationOnce(() => {
          throw new Error('interrupted final receipt persistence')
        })
      const firstNotify = vi.spyOn(s.runtime, 'notifyMessageArrived')

      expect(await firstDispatcher.dispatch(send)).toMatchObject({
        ok: false,
        error: { code: 'runtime_error', message: 'interrupted final receipt persistence' }
      })
      expect(persist).toHaveBeenCalledTimes(2)
      expect(firstNotify).not.toHaveBeenCalled()
      expect(s.db.getUnreadMessages(`run:${runId}`)).toEqual([])
      const intermediate = storedReceipt(send.orchestrationRequestId!)
      expect(intermediate).toMatchObject({ state: 'completed' })
      persist.mockRestore()

      const runtime = retryMode === 'warm' ? s.runtime : new OrcaRuntimeService()
      if (retryMode === 'reconstructed') {
        runtime.setOrchestrationDb(s.db)
        bindWorkerPane(runtime)
      }
      const notify = vi.spyOn(runtime, 'notifyMessageArrived')
      const dispatcher =
        retryMode === 'warm'
          ? firstDispatcher
          : new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      let awakened = false
      const waiting = runtime
        .waitForMessage(`run:${runId}`, { timeoutMs: 5_000, typeFilter: ['status'] })
        .then((result) => {
          awakened = true
          return result
        })
      const replayed = await dispatcher.dispatch({ ...send, id: `${send.id}_retry` })

      expect(replayed).toMatchObject({
        ok: true,
        result: { mutation: { requestId: send.orchestrationRequestId, replayed: true } }
      })
      expect(s.db.getUnreadMessages(`run:${runId}`)).toEqual([])
      expect(s.db.getInbox()).toEqual([
        expect.objectContaining({
          subject: 'Stopping worker status',
          read: 1,
          delivered_at: expect.any(String)
        })
      ])
      expect(notify).not.toHaveBeenCalled()
      expect(awakened).toBe(false)
      runtime.cancelMessageWaiters(`run:${runId}`)
      await expect(waiting).resolves.toBe('cancelled')
      expect(s.db.getWorkerDispatch(worker.dispatchId)?.state).toBe('stopping')
      expect(intermediate?.receipt).not.toContain('__orcaReplayNudge')
      expect(storedReceipt(send.orchestrationRequestId!)).toEqual(intermediate)
    }
  )
})
