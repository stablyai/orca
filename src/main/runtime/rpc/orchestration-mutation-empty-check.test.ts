import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { createOrchestrationRetryRequestId } from '../../../shared/orchestration-retry-request-id'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createOrchestrationRpcHarness } from './methods/orchestration/rpc-test-harness'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

const h = createOrchestrationRpcHarness()
afterEach(() => h.cleanup())

function check(requestId: string, params: unknown, retry?: true): RpcRequest {
  return {
    id: 'rpc',
    authToken: 'fixture',
    method: 'orchestration.check',
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: requestId,
    orchestrationRequestRetry: retry
  }
}

describe('empty consuming check receipts', () => {
  it.each(['run', 'worker', 'direct'])(
    'does not keep an empty %s check; lost-reply retry can receive later mail',
    async (mailbox) => {
      const { db, runtime, activeRunId } = h.setup(mailbox !== 'direct')
      const messageRunId =
        activeRunId ??
        db.createRun({
          objective: 'Direct mailbox',
          coordinatorHandle: null,
          coordinatorPaneKey: null
        }).id
      const terminal = 'term_coord'
      const params = { terminal, ...(mailbox === 'run' ? { run: activeRunId } : {}) }
      let address = terminal
      if (mailbox === 'worker') {
        const task = db.createTask({ spec: 'worker mail', runId: activeRunId })
        const dispatch = createRootDispatch(db, task.id, terminal, h.coordinatorPaneKey)
        db.db
          .prepare(
            'UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL WHERE id = ?'
          )
          .run(messageRunId)
        address = `dispatch:${dispatch.id}`
      } else if (mailbox === 'run') {
        address = `run:${activeRunId}`
      }
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      const requestId = createOrchestrationRetryRequestId()
      const fingerprint = db.getOrCreateLocalMutationCallerFingerprint()
      expect(await dispatcher.dispatch(check(requestId, params))).toMatchObject({
        ok: true,
        result: { count: 0 }
      })
      expect(db.getMutationReceipt(fingerprint, requestId)).toBeUndefined()
      expect(await dispatcher.dispatch(check(requestId, params, true))).toMatchObject({
        ok: true,
        result: { count: 0 }
      })
      db.insertMessage({
        from: 'sender',
        to: address,
        runId: messageRunId,
        subject: 'arrived later'
      })
      expect(await dispatcher.dispatch(check(requestId, params, true))).toMatchObject({
        ok: true,
        result: { count: 1, messages: [{ subject: 'arrived later' }] }
      })
      expect(db.getMutationReceipt(fingerprint, requestId)?.state).toBe('completed')
      expect(await dispatcher.dispatch(check(requestId, params, true))).toMatchObject({
        ok: true,
        result: { count: 1, mutation: { replayed: true } }
      })
    }
  )

  it('keeps an empty result that acknowledged a previous batch', async () => {
    const { db, runtime, activeRunId } = h.setup()
    db.insertMessage({ from: 'sender', to: `run:${activeRunId}`, subject: 'consume me' })
    const run = db.getRun(activeRunId ?? '')
    if (!run) {
      throw new Error('Run missing')
    }
    const delivery = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })
    const requestId = createOrchestrationRetryRequestId()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const params = { terminal: 'term_coord', run: activeRunId, ack: delivery?.delivery.id }
    expect(await dispatcher.dispatch(check(requestId, params))).toMatchObject({
      ok: true,
      result: { count: 0, acknowledged: delivery?.delivery.id }
    })
    expect(
      db.getMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), requestId)?.state
    ).toBe('completed')
    expect(await dispatcher.dispatch(check(requestId, params, true))).toMatchObject({
      ok: true,
      result: { count: 0, mutation: { replayed: true } }
    })
  })

  it.each(['timed_out', 'cancelled'] as const)(
    'discards an empty %s wait with no acknowledgment',
    async (outcome) => {
      const { db, runtime, activeRunId } = h.setup()
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue(outcome)
      const requestId = createOrchestrationRetryRequestId()
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      expect(
        await dispatcher.dispatch(
          check(requestId, { terminal: 'term_coord', run: activeRunId, wait: true })
        )
      ).toMatchObject({ ok: true, result: { count: 0 } })
      expect(
        db.getMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), requestId)
      ).toBeUndefined()
    }
  )
})
