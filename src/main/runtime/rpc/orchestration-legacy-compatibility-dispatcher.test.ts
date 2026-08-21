import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { applyEscalationToDispatch } from '../orchestration/coordinator-escalation-triage'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  COORDINATOR_PANE,
  counts,
  createHarness,
  escalationParams,
  evidence,
  invoke,
  request,
  WORKER_HANDLE,
  WORKER_PANE
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('legacy compatibility through RpcDispatcher', () => {
  it('rejects malformed current-contract input before compatibility attestation', async () => {
    const harness = createHarness()
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        { from: WORKER_HANDLE, type: 'escalation' },
        evidence('worker'),
        'malformed'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(harness.verify).not.toHaveBeenCalled()
    expect(counts(harness.db)).toEqual(before)
  })

  it.each([
    ['dispatch', true],
    ['dispatch', false],
    ['websocket', true],
    ['websocket', false]
  ] as const)(
    '%s routes task-only escalation with valid proof=%s and zero partial effects',
    async (transport, valid) => {
      const harness = createHarness()
      const before = counts(harness.db)
      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.send',
          {
            ...escalationParams(harness),
            payload: JSON.stringify({ taskId: harness.taskId })
          },
          evidence('worker', valid),
          `${transport}-${valid}`
        ),
        transport
      )

      if (!valid) {
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'legacy_read_only' }
        })
        expect(counts(harness.db)).toEqual(before)
        expect(harness.notify).not.toHaveBeenCalled()
        return
      }

      expect(response).toMatchObject({
        ok: true,
        result: {
          message: { type: 'escalation', delivery_contract: 'legacy_direct' },
          legacyCompatibility: { replayed: false }
        }
      })
      const message = (response as { result: { message: { id: string; payload: string } } }).result
        .message
      expect(JSON.parse(message.payload)).toMatchObject({
        taskId: harness.taskId,
        dispatchId: harness.dispatchId
      })
      applyEscalationToDispatch(harness.db, harness.db.getMessageById(message.id)!, () => {})
      expect(harness.db.getTask(harness.taskId)?.status).toBe('ready')
      expect(harness.db.getDispatchContextById(harness.dispatchId)?.status).toBe('failed')
      expect(counts(harness.db)).toEqual({
        ...before,
        messages: before.messages + 1,
        legacy_compatibility_principals: before.legacy_compatibility_principals + 1,
        legacy_operation_receipts: before.legacy_operation_receipts + 1
      })
      expect(harness.notify).toHaveBeenCalledOnce()
    }
  )

  it('validates, infers, settles, and replays legacy worker completion exactly once', async () => {
    const harness = createHarness()
    const baseParams = {
      from: WORKER_HANDLE,
      to: COORDINATOR_HANDLE,
      type: 'worker_done',
      body: 'legacy result',
      payload: JSON.stringify({ taskId: harness.taskId, dispatchId: harness.dispatchId })
    }
    const before = counts(harness.db)
    const invalid = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        { ...baseParams, subject: 'Completed', payload: JSON.stringify({ outcome: 'maybe' }) },
        evidence('worker'),
        'invalid-outcome'
      )
    )

    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(counts(harness.db)).toEqual(before)

    const firstRequest = request(
      'orchestration.send',
      { ...baseParams, subject: 'Completed' },
      evidence('worker'),
      'completion'
    )
    const first = await harness.dispatcher.dispatch(firstRequest)
    const replay = await harness.dispatcher.dispatch({ ...firstRequest, id: 'rpc_replay' })
    const mismatch = await harness.dispatcher.dispatch({
      ...firstRequest,
      id: 'rpc_mismatch',
      params: { ...baseParams, subject: 'Changed completion' }
    })

    expect(first).toMatchObject({
      ok: true,
      result: {
        lifecycle: { action: 'settled', outcome: 'succeeded' },
        legacyCompatibility: { replayed: false }
      }
    })
    expect(replay).toMatchObject({
      ok: true,
      result: { legacyCompatibility: { replayed: true } }
    })
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(harness.db.getTask(harness.taskId)?.status).toBe('completed')
    expect(harness.db.getDispatchContextById(harness.dispatchId)?.status).toBe('completed')
    expect(counts(harness.db)).toEqual({
      ...before,
      messages: before.messages + 1,
      legacy_compatibility_principals: before.legacy_compatibility_principals + 1,
      legacy_operation_receipts: before.legacy_operation_receipts + 1
    })
    expect(harness.notify).toHaveBeenCalledOnce()
  })

  it('replays an A-era completion without touching a newer current attempt', async () => {
    const harness = createHarness()
    const payload = JSON.stringify({
      taskId: harness.taskId,
      dispatchId: harness.dispatchId
    })
    const completion = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: WORKER_HANDLE,
      to: COORDINATOR_HANDLE,
      subject: 'Failed: pinned A treated this as complete',
      body: 'persisted result',
      type: 'worker_done',
      payload,
      senderPaneKey: WORKER_PANE,
      deliveryContract: 'legacy_direct'
    })
    harness.db.settleWorkerReport({
      taskId: harness.taskId,
      dispatchId: harness.dispatchId,
      outcome: 'succeeded',
      result: 'persisted result'
    })
    harness.db.commitLegacyCompatibilityPrincipal({
      runId: harness.adoptedRunId,
      dispatchId: harness.dispatchId,
      role: 'worker',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      terminalHandle: WORKER_HANDLE,
      paneKey: WORKER_PANE,
      launchTokenHash: createHash('sha256').update('worker-token').digest('hex'),
      processIncarnation: 'process-1'
    })
    harness.db.updateTaskStatus(harness.taskId, 'ready')
    const currentDispatch = harness.db.createDispatchContext(
      harness.taskId,
      'term_current_worker',
      'tab_current_worker:77777777-7777-4777-8777-777777777777',
      'current-launch-hash'
    )
    const currentTaskBefore = harness.db.getTask(harness.taskId)
    const currentDispatchBefore = harness.db.getDispatchContextById(currentDispatch.id)
    const before = counts(harness.db)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: WORKER_HANDLE,
          to: COORDINATOR_HANDLE,
          subject: completion.subject,
          body: completion.body,
          type: 'worker_done',
          payload
        },
        evidence('worker'),
        'reconstruct-pinned-a-completion'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        message: { id: completion.id },
        lifecycle: { action: 'settled', outcome: 'succeeded', duplicate: true }
      }
    })
    expect(harness.db.getTask(harness.taskId)).toEqual(currentTaskBefore)
    expect(harness.db.getDispatchContextById(harness.dispatchId)?.status).toBe('completed')
    expect(harness.db.getDispatchContextById(currentDispatch.id)).toEqual(currentDispatchBefore)
    expect(counts(harness.db)).toEqual({
      ...before,
      legacy_operation_receipts: before.legacy_operation_receipts + 1
    })
  })

  it('rejects a legacy lifecycle recipient outside the adopted Run with zero effects', async () => {
    const harness = createHarness()
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          ...escalationParams(harness),
          to: 'term_unrelated'
        },
        evidence('worker'),
        'wrong-recipient'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'request_mismatch' }
    })
    expect(counts(harness.db)).toEqual(before)
    expect(harness.verify).not.toHaveBeenCalled()
    expect(harness.notify).not.toHaveBeenCalled()
  })

  it('rejects a reused pane whose live process incarnation is not the legacy worker', async () => {
    const harness = createHarness()
    const sqlite = (harness.db as unknown as { db: Database.Database }).db
    sqlite
      .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
      .run('different-process', harness.dispatchId)
    const before = counts(harness.db)

    const response = await harness.dispatcher.dispatch(
      request('orchestration.send', escalationParams(harness), evidence('worker'), 'reused-pane')
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
    expect(counts(harness.db)).toEqual(before)
    expect(harness.notify).not.toHaveBeenCalled()
  })

  it('rejects a legacy question recipient outside the adopted Run with zero effects', async () => {
    const harness = createHarness()
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        {
          from: WORKER_HANDLE,
          to: 'term_unrelated',
          question: 'Proceed?',
          timeoutMs: 1
        },
        evidence('worker'),
        'wrong-question-recipient'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'request_mismatch' }
    })
    expect(counts(harness.db)).toEqual(before)
    expect(harness.verify).not.toHaveBeenCalled()
    expect(harness.notify).not.toHaveBeenCalled()
  })

  it('keeps distinct compatibility ask invocations on distinct questions', async () => {
    const harness = createHarness()
    const ask = {
      from: WORKER_HANDLE,
      to: COORDINATOR_HANDLE,
      question: 'Same question?',
      options: ['yes', 'no'],
      timeoutMs: 1
    }
    const first = await harness.dispatcher.dispatch(
      request('orchestration.ask', ask, evidence('worker'), 'ask-one')
    )
    const replay = await harness.dispatcher.dispatch(
      request('orchestration.ask', ask, evidence('worker'), 'ask-one')
    )
    const second = await harness.dispatcher.dispatch(
      request('orchestration.ask', ask, evidence('worker'), 'ask-two')
    )

    expect(first).toMatchObject({ ok: true, result: { legacyCompatibility: { replayed: false } } })
    expect(replay).toMatchObject({ ok: true, result: { legacyCompatibility: { replayed: true } } })
    expect(second).toMatchObject({ ok: true, result: { legacyCompatibility: { replayed: false } } })
    const firstId = (first as { result: { messageId: string } }).result.messageId
    const replayId = (replay as { result: { messageId: string } }).result.messageId
    const secondId = (second as { result: { messageId: string } }).result.messageId
    expect(replayId).toBe(firstId)
    expect(secondId).not.toBe(firstId)
    expect(harness.db.getMessageById(firstId)?.type).toBe('decision_gate')

    const coordinatorCheck = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        {
          terminal: COORDINATOR_HANDLE,
          types: 'worker_done,escalation,decision_gate',
          format: true
        },
        evidence('coordinator'),
        'coordinator-check-decision-gates'
      )
    )
    expect(coordinatorCheck).toMatchObject({
      ok: true,
      result: {
        messages: [
          { id: firstId, type: 'decision_gate' },
          { id: secondId, type: 'decision_gate' }
        ],
        count: 2
      }
    })
    expect((coordinatorCheck as { result: { formatted: string } }).result.formatted).toContain(
      `orca orchestration reply --id ${firstId}`
    )
  })

  it('keeps the normal wait budget when legacy check omits timeout', async () => {
    const harness = createHarness()
    const waitForMessage = vi
      .spyOn(harness.runtime, 'waitForMessage')
      .mockResolvedValue('timed_out')
    let clockReads = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      clockReads += 1
      return clockReads === 1 ? 0 : clockReads === 2 ? 1 : 120_001
    })

    try {
      const response = await harness.dispatcher.dispatch(
        request(
          'orchestration.check',
          { terminal: WORKER_HANDLE, wait: true },
          evidence('worker'),
          'legacy-check-default-timeout'
        )
      )

      expect(response).toMatchObject({
        ok: true,
        result: { messages: [], count: 0, timedOut: true }
      })
      expect(waitForMessage).toHaveBeenCalledOnce()
    } finally {
      now.mockRestore()
    }
  })

  it('does not infer an outcome for a current Dispatch when legacy adoption exists', async () => {
    const harness = createHarness()
    const run = harness.db.createRun({
      objective: 'current work',
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current_coord:55555555-5555-4555-8555-555555555555'
    })
    const task = harness.db.createTask({ spec: 'current assignment', runId: run.id })
    const dispatch = harness.db.createDispatchContext(
      task.id,
      'term_current_worker',
      'tab_current_worker:66666666-6666-4666-8666-666666666666',
      'current-launch-hash'
    )
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: 'term_current_worker',
          to: COORDINATOR_HANDLE,
          subject: 'Completed',
          type: 'worker_done',
          payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
        },
        {
          terminalHandle: 'term_current_worker',
          paneKey: 'tab_current_worker:66666666-6666-4666-8666-666666666666',
          launchToken: 'current-token'
        },
        'current-missing-outcome'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(harness.db.getTask(task.id)?.status).toBe('dispatched')
    expect(harness.db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(counts(harness.db)).toEqual(before)
  })

  it('rejects invalid typed ACKs and consumes only the filtered legacy page', async () => {
    const harness = createHarness()
    await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          ...escalationParams(harness),
          type: 'worker_done',
          subject: 'Completed',
          payload: JSON.stringify({ taskId: harness.taskId, dispatchId: harness.dispatchId })
        },
        evidence('worker'),
        'settle-for-mail'
      )
    )
    const status = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: COORDINATOR_HANDLE,
      to: WORKER_HANDLE,
      subject: 'status first',
      type: 'status',
      deliveryContract: 'legacy_direct'
    })
    const question = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: COORDINATOR_HANDLE,
      to: WORKER_HANDLE,
      subject: 'question second',
      type: 'question',
      deliveryContract: 'legacy_direct'
    })
    const check = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: WORKER_HANDLE, types: 'question' },
        evidence('worker'),
        'question-check'
      )
    )
    expect(check).toMatchObject({
      ok: true,
      result: {
        messages: [{ id: question.id }],
        legacyCompatibility: { ackMessageIds: [question.id] }
      }
    })

    const invalid = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        {
          terminal: WORKER_HANDLE,
          compatibilityAck: JSON.stringify({
            messageIds: [question.id],
            types: ['not-a-message-type']
          })
        },
        evidence('worker'),
        'invalid-ack'
      )
    )
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(harness.db.getMessageById(status.id)?.read).toBe(0)
    expect(harness.db.getMessageById(question.id)?.read).toBe(0)

    const acknowledged = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        {
          terminal: WORKER_HANDLE,
          compatibilityAck: JSON.stringify({
            messageIds: [question.id],
            types: ['question']
          })
        },
        evidence('worker'),
        'valid-ack'
      )
    )
    expect(acknowledged).toMatchObject({
      ok: true,
      result: { acknowledged: [question.id], legacyCompatibility: { acknowledged: true } }
    })
    expect(harness.db.getMessageById(status.id)?.read).toBe(0)
    expect(harness.db.getMessageById(question.id)?.read).toBe(1)
  })

  it('rejects invalid legacy check types before attestation or mail consumption', async () => {
    const harness = createHarness()
    const message = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: COORDINATOR_HANDLE,
      to: WORKER_HANDLE,
      subject: 'retained status',
      type: 'status',
      deliveryContract: 'legacy_direct'
    })
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: WORKER_HANDLE, types: 'status,not-a-message-type' },
        evidence('worker'),
        'invalid-types'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Invalid --types: not-a-message-type' }
    })
    expect(counts(harness.db)).toEqual(before)
    expect(harness.db.getMessageById(message.id)?.read).toBe(0)
    expect(harness.verify).not.toHaveBeenCalled()
    expect(harness.notify).not.toHaveBeenCalled()
  })

  it('advertises only Run-addressed current delivery to a legacy coordinator', async () => {
    const harness = createHarness()
    harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: 'term_current_worker',
      to: WORKER_HANDLE,
      subject: 'worker-only current mail',
      deliveryContract: 'current_delivery'
    })
    const workerOnly = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'worker-current-mail'
      )
    )
    expect(workerOnly).toMatchObject({
      ok: true,
      result: { legacyCompatibility: { currentDelivery: undefined } }
    })

    harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: 'term_current_worker',
      to: `run:${harness.adoptedRunId}`,
      subject: 'Run current mail',
      deliveryContract: 'current_delivery'
    })
    const runMail = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'run-current-mail'
      )
    )
    expect(runMail).toMatchObject({
      ok: true,
      result: {
        legacyCompatibility: {
          currentDelivery: {
            runId: harness.adoptedRunId,
            checkCommand: expect.stringContaining(`--run ${harness.adoptedRunId}`)
          }
        }
      }
    })
  })

  it('rejects a legacy coordinator reply outside the adopted Run with zero effects', async () => {
    const harness = createHarness()
    const unrelatedRun = harness.db.createRun({
      objective: 'unrelated current work',
      coordinatorHandle: 'term_unrelated_coord',
      coordinatorPaneKey: 'tab_unrelated_coord:55555555-5555-4555-8555-555555555555'
    })
    const unrelated = harness.db.insertMessage({
      runId: unrelatedRun.id,
      from: 'term_unrelated_worker',
      to: `run:${unrelatedRun.id}`,
      subject: 'Unrelated current status',
      deliveryContract: 'current_delivery'
    })
    const before = counts(harness.db)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.reply',
        {
          id: unrelated.id,
          body: 'Forged cross-Run reply',
          from: COORDINATOR_HANDLE,
          run: harness.adoptedRunId
        },
        evidence('coordinator'),
        'cross-run-reply'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'request_mismatch',
        data: { effectsApplied: false }
      }
    })
    expect(counts(harness.db)).toEqual(before)
    expect(harness.db.getMessageById(unrelated.id)?.read).toBe(0)
    expect(harness.notify).not.toHaveBeenCalled()
  })

  it('keeps explicit adopted Run task inspection available to unrelated callers', async () => {
    const harness = createHarness()
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskList',
        { run: harness.adoptedRunId, callerTerminalHandle: 'term_unrelated' },
        {
          terminalHandle: 'term_unrelated',
          paneKey: 'tab_unrelated:55555555-5555-4555-8555-555555555555',
          launchToken: 'unrelated-token'
        },
        'explicit-adopted-run-inspection'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        runId: harness.adoptedRunId,
        tasks: [expect.objectContaining({ id: harness.taskId })]
      }
    })
    expect(counts(harness.db)).toEqual(before)
    expect(harness.verify).not.toHaveBeenCalled()
  })

  it.each(['dispatch', 'websocket'] as const)(
    '%s binds an attested coordinator once and rejects contradictory proof before binding',
    async (transport) => {
      const invalidHarness = createHarness()
      const invalidBefore = counts(invalidHarness.db)
      const rejected = await invoke(
        invalidHarness.dispatcher,
        request(
          'orchestration.runUse',
          { id: invalidHarness.adoptedRunId, from: COORDINATOR_HANDLE },
          evidence('coordinator', false),
          `run-use-invalid-${transport}`
        ),
        transport
      )
      expect(rejected).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
      expect(invalidHarness.db.getRun(invalidHarness.adoptedRunId)?.consumer_generation).toBe(0)
      expect(counts(invalidHarness.db)).toEqual(invalidBefore)

      const harness = createHarness()
      const runUse = request(
        'orchestration.runUse',
        { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        `run-use-${transport}`
      )
      const first = await invoke(harness.dispatcher, runUse, transport)
      const replay = await invoke(
        harness.dispatcher,
        { ...runUse, id: 'rpc_run-use-replay' },
        transport
      )
      expect(first).toMatchObject({
        ok: true,
        result: { binding: { consumerGeneration: 1 }, mutation: { replayed: false } }
      })
      expect(replay).toMatchObject({
        ok: true,
        result: { binding: { consumerGeneration: 1 }, mutation: { replayed: true } }
      })
      expect(harness.db.getRun(harness.adoptedRunId)?.consumer_generation).toBe(1)
    }
  )

  it('passes trusted coordinator scope to a failing handler without binding or receipts', async () => {
    const harness = createHarness()
    const before = counts(harness.db)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskUpdate',
        {
          id: 'task_missing',
          status: 'completed',
          callerTerminalHandle: COORDINATOR_HANDLE
        },
        evidence('coordinator'),
        'missing-task'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'task_not_found' } })
    expect(harness.db.getRun(harness.adoptedRunId)?.consumer_generation).toBe(0)
    expect(counts(harness.db)).toEqual(before)
  })

  it('rejects stale legacy coordinator proof after current takeover', async () => {
    const harness = createHarness()
    const principal = harness.db.commitLegacyCompatibilityPrincipal({
      runId: harness.adoptedRunId,
      role: 'coordinator',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      terminalHandle: COORDINATOR_HANDLE,
      paneKey: COORDINATOR_PANE,
      launchTokenHash: createHash('sha256').update('coordinator-token').digest('hex'),
      processIncarnation: 'process-1'
    }).principal
    harness.db.settleWorkerReport({
      taskId: harness.taskId,
      dispatchId: harness.dispatchId,
      outcome: 'succeeded',
      result: 'done'
    })
    harness.db.bindRun({
      runId: harness.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:55555555-5555-4555-8555-555555555555'
    })
    expect(harness.db.getLegacyCompatibilityPrincipal(principal.id)?.status).toBe('revoked')
    const before = counts(harness.db)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskList',
        {},
        evidence('coordinator'),
        'stale-coordinator-after-takeover'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
    expect(counts(harness.db)).toEqual(before)
  })
})
