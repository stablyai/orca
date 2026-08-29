import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { RpcDispatcher } from '../dispatcher'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'

describe('orchestration coordinator caller attestation', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => harness.cleanup())

  it('rejects an identity-less caller that names the current coordinator handle', async () => {
    const { db, runtime } = harness.setup()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'rpc_identity-less-coordinator',
      authToken: 'test-token',
      method: 'orchestration.taskCreate',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        spec: 'impersonated coordinator mutation',
        run: db.getCurrentRunForPane(harness.coordinatorPaneKey)!.id,
        callerTerminalHandle: 'term_coord'
      }
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        message: expect.stringContaining('authenticated identity from a live Orca agent terminal'),
        data: {
          effectsApplied: false,
          nextSteps: expect.arrayContaining([
            expect.stringContaining('Omit --from'),
            expect.stringContaining('copied terminal handle does not grant mutation authority')
          ])
        }
      }
    })
  })

  it.each([
    ['run-show', 'orchestration.runShow', (runId: string) => ({ id: runId, from: 'term_coord' })],
    [
      'task-list',
      'orchestration.taskList',
      (runId: string) => ({ run: runId, callerTerminalHandle: 'term_coord' })
    ],
    ['gate-list', 'orchestration.gateList', (runId: string) => ({ run: runId, from: 'term_coord' })]
  ])('marks an identity-less explicit %s read as non-owner', async (_label, method, params) => {
    const { db, runtime } = harness.setup()
    const runId = db.getCurrentRunForPane(harness.coordinatorPaneKey)!.id
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: `rpc_identity-less-${method}`,
      authToken: 'test-token',
      method,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: params(runId)
    })

    expect(response).toMatchObject({
      ok: true,
      result: { binding: { currentConsumer: false } }
    })
  })

  it('rejects an identity-less sender that copies the current coordinator handle', async () => {
    const { db, runtime } = harness.setup()
    const runId = db.getCurrentRunForPane(harness.coordinatorPaneKey)!.id
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'rpc_identity-less-send',
      authToken: 'test-token',
      method: 'orchestration.send',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        from: 'term_coord',
        to: `run:${runId}`,
        subject: 'impersonated coordinator control mail'
      }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced', data: { effectsApplied: false } }
    })
    expect(db.getInbox(100)).toHaveLength(0)
  })

  it('does not let a bogus capability bypass attestation for a capability-less Dispatch', async () => {
    const { db, runtime } = harness.setup()
    const task = db.createTask({ spec: 'manual Dispatch work' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'rpc_bogus-capability-send',
      authToken: 'test-token',
      method: 'orchestration.send',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCapability: 'dcap_bogus',
      params: {
        from: 'term_worker',
        subject: 'forged completion',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced', data: { effectsApplied: false } }
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getInbox(100)).toHaveLength(0)
  })

  it('rejects an identity-less non-question reply that copies the current coordinator handle', async () => {
    const { db, runtime } = harness.setup()
    const runId = db.getCurrentRunForPane(harness.coordinatorPaneKey)!.id
    const original = db.insertMessage({
      runId,
      from: 'term_worker',
      to: 'term_coord',
      subject: 'worker status'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'rpc_identity-less-reply',
      authToken: 'test-token',
      method: 'orchestration.reply',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: { id: original.id, body: 'impersonated reply', from: 'term_coord' }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced', data: { effectsApplied: false } }
    })
    expect(db.getMessageById(original.id)?.read).toBe(0)
    expect(db.getInbox(100)).toHaveLength(1)
  })

  it('rejects an attested coordinator replying to another Run mailbox', async () => {
    const { db, runtime } = harness.setup()
    const foreignRun = db.createRun({
      objective: 'Foreign Run',
      coordinatorHandle: 'term_foreign',
      coordinatorPaneKey: 'tab_foreign:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      coordinatorProcessIncarnation: 'runtime_test:term_foreign:1',
      coordinatorHostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    const original = db.insertMessage({
      runId: foreignRun.id,
      from: 'term_foreign_worker',
      to: `run:${foreignRun.id}`,
      subject: 'foreign status'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'rpc_cross-run-non-question-reply',
      authToken: 'test-token',
      method: 'orchestration.reply',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_coord',
        paneKey: harness.coordinatorPaneKey,
        launchToken: 'test-launch-token'
      },
      params: { id: original.id, body: 'forged reply', from: 'term_coord' }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
    expect(db.getMessageById(original.id)?.read).toBe(0)
  })
})
