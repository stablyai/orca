import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { applyEscalationToDispatch } from '../orchestration/coordinator/escalation/coordinator-escalation-triage'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  counts,
  createHarness,
  escalationParams,
  evidence,
  invoke,
  request,
  WORKER_HANDLE,
  WORKER_PANE
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
})

describe('legacy compatibility through RpcDispatcher', () => {
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
    // Recreate the pre-boundary state where A settled before a current attempt was persisted.
    const sqlite = (harness.db as unknown as { db: Database.Database }).db
    sqlite.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(harness.taskId)
    const currentDispatch = createRootDispatch(
      harness.db,
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
        result: { run: { consumer_generation: 1 }, mutation: { replayed: false } }
      })
      expect(replay).toMatchObject({
        ok: true,
        result: { run: { consumer_generation: 1 }, mutation: { replayed: true } }
      })
      expect(harness.db.getRun(harness.adoptedRunId)?.consumer_generation).toBe(1)
    }
  )
})
