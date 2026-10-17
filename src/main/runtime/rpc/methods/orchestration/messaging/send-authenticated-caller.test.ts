import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RpcContext } from '../../../core'
import {
  createRootDispatch,
  reattachDispatchConsumer
} from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { testOrcaSessionId } from '../../../../../../shared/orca-session-address-test-fixture'

const SESSION_ID = testOrcaSessionId('11111111-1111-4111-8111-111111111111')

describe('orchestration.send authenticated lifecycle caller', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  it('rejects nested replay without settling or revoking the outer worker', async () => {
    const { db, runtime, activeRunId } = harness.setup()
    const task = db.createTask({ spec: 'outer work remains active' })
    const dispatch = createRootDispatch(db, task.id, 'term_outer', 'tab_outer:leaf_outer')
    const payload = JSON.stringify({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })
    const call = (ctx: RpcContext) =>
      harness.call(
        'orchestration.send',
        { from: 'term_outer', subject: 'Done', type: 'worker_done', payload },
        ctx
      )
    const context = (
      terminalHandle: string,
      paneKey: string,
      processIncarnation = `runtime_test:${terminalHandle}:1`
    ): RpcContext => ({
      runtime,
      orchestrationCompatibilityCallerAuthority: {
        hostScope: { kind: 'local', hostId: 'local' },
        terminalHandle,
        paneKey,
        processIncarnation,
        launchTokenHash: 'launch-token-hash'
      }
    })

    await expect(call(context('term_nested', 'tab_nested:leaf_nested'))).rejects.toMatchObject({
      code: 'sender_not_assignee'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'dispatched',
      capability_revoked_at: null
    })
    expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(0)

    reattachDispatchConsumer(db, {
      dispatchId: dispatch.id,
      paneKey: 'tab_outer:leaf_outer',
      processIncarnation: 'runtime_test:term_outer:2'
    })
    await expect(call(context('term_outer', 'tab_outer:leaf_outer'))).resolves.toMatchObject({
      lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'dispatched',
      capability_revoked_at: null
    })

    const currentContext = context(
      'term_outer',
      'tab_outer:leaf_outer',
      'runtime_test:term_outer:2'
    )
    const accepted = z
      .object({
        message: z.object({ payload: z.string() }),
        lifecycle: z.object({ action: z.string() })
      })
      .parse(await call(currentContext))
    expect(accepted.lifecycle.action).toBe('completed')
    expect(JSON.parse(accepted.message.payload)).toMatchObject({
      providerSenderAttestation: {
        version: 1,
        dispatchId: dispatch.id,
        taskId: task.id,
        terminalHandle: 'term_outer',
        paneKey: 'tab_outer:leaf_outer',
        processIncarnation: 'runtime_test:term_outer:2',
        consumerGeneration: 1
      }
    })
  })

  it('binds an ingress-captured session process and consumer generation', async () => {
    const { db, runtime } = harness.setup()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockClear()
    const task = db.createTask({ spec: 'session worker' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_outer',
      'tab_outer:leaf_outer',
      undefined,
      'runtime_test:term_outer:1'
    )
    const payload = JSON.stringify({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })
    const caller = {
      address: 'term_outer',
      terminalHandle: 'term_outer',
      paneKey: 'tab_outer:leaf_outer',
      orcaSessionId: SESSION_ID,
      sessionId: SESSION_ID,
      workspaceId: 'workspace-1',
      processIncarnation: 'runtime_test:term_outer:1'
    } as const
    const call = () =>
      harness.call(
        'orchestration.send',
        { from: 'term_outer', subject: 'Done', type: 'worker_done', payload },
        { runtime, orchestrationCaller: caller }
      )

    reattachDispatchConsumer(db, {
      dispatchId: dispatch.id,
      paneKey: 'tab_outer:leaf_outer',
      processIncarnation: 'runtime_test:term_outer:2'
    })
    await expect(call()).resolves.toMatchObject({
      lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
    })
    expect(runtime.getTerminalProcessIncarnation).not.toHaveBeenCalled()

    const currentCaller = {
      ...caller,
      processIncarnation: 'runtime_test:term_outer:2'
    } as const
    const accepted = z
      .object({
        message: z.object({ payload: z.string() }),
        lifecycle: z.object({ action: z.string() })
      })
      .parse(
        await harness.call(
          'orchestration.send',
          { from: 'term_outer', subject: 'Done', type: 'worker_done', payload },
          { runtime, orchestrationCaller: currentCaller }
        )
      )
    expect(accepted.lifecycle.action).toBe('completed')
    expect(JSON.parse(accepted.message.payload)).toMatchObject({
      providerSenderAttestation: {
        terminalHandle: 'term_outer',
        paneKey: 'tab_outer:leaf_outer',
        processIncarnation: 'runtime_test:term_outer:2',
        consumerGeneration: 1
      }
    })
  })

  it('strips caller-supplied provider attestation from an unattested report', async () => {
    const { db, runtime } = harness.setup()
    const task = db.createTask({ spec: 'legacy worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_outer', 'tab_outer:leaf_outer')
    const result = z
      .object({
        message: z.object({ payload: z.string() }),
        lifecycle: z.object({ action: z.string() })
      })
      .parse(
        await harness.call(
          'orchestration.send',
          {
            from: 'term_outer',
            subject: 'Done',
            type: 'worker_done',
            payload: JSON.stringify({
              taskId: task.id,
              dispatchId: dispatch.id,
              outcome: 'succeeded',
              providerSenderAttestation: {
                terminalHandle: 'term_outer',
                paneKey: 'tab_outer:leaf_outer',
                processIncarnation: 'forged',
                consumerGeneration: 0
              }
            })
          },
          { runtime }
        )
      )

    expect(result.lifecycle.action).toBe('rejected')
    expect(JSON.parse(result.message.payload)).not.toHaveProperty('providerSenderAttestation')
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })
})
