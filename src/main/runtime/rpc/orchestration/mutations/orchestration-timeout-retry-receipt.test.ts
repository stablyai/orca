import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../shared/orchestration/orchestration-rpc-contract'

import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'

import { LEGACY_CONTRACT_VERSION } from '../../../orchestration/db/contract-constants'
import '../../../orchestration/db/messages/mailbox-routing-page'
import '../../../orchestration/db/dispatch-row-writer'
import '../../../orchestration/db/attempt-outcome-projection'
import { MUTATION_RECEIPT_MAX_ROWS } from '../../../orchestration/db/mutation-receipts/mutation-receipt-capacity'

import type { RpcRequest, RpcResponse } from '../../core'

import { RpcDispatcher } from '../../dispatcher'

import { ORCHESTRATION_METHODS } from '../../methods/orchestration/orchestration'

import { createOrchestrationRpcHarness } from '../../methods/orchestration/rpc-test-harness'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function receiptCount(db: OrchestrationDb): number {
  const row: unknown = db.db.prepare('SELECT receipt_count FROM mutation_receipt_ledger').get()
  if (!isRecord(row) || typeof row.receipt_count !== 'number') {
    throw new Error('mutation receipt ledger row missing')
  }
  return row.receipt_count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sentMessageId(response: RpcResponse): string {
  const message = response.ok && isRecord(response.result) ? response.result.message : undefined
  if (!isRecord(message) || typeof message.id !== 'string') {
    throw new Error('worker_done response carried no message id')
  }
  return message.id
}

/** Leaves exactly one free receipt slot, held by unresolved operations of another caller. */
function fillLedgerToOneFreeSlot(db: OrchestrationDb): void {
  db.db
    .prepare(
      `WITH RECURSIVE receipt_numbers(value) AS (
         VALUES (1)
         UNION ALL
         SELECT value + 1 FROM receipt_numbers WHERE value < ?
       )
       INSERT INTO mutation_receipts (
         caller_fingerprint, request_id, method, payload_hash, state
       )
       SELECT 'other-caller', printf('pending_%05d', value), 'orchestration.send',
              printf('hash_%05d', value), 'pending'
       FROM receipt_numbers`
    )
    .run(MUTATION_RECEIPT_MAX_ROWS - 1 - receiptCount(db))
  expect(receiptCount(db)).toBe(MUTATION_RECEIPT_MAX_ROWS - 1)
}

describe('worker_done retry after a possibly delivered timeout', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => {
    harness.cleanup()
  })

  function setupWorker() {
    const { db, runtime, activeRunId } = harness.setup()
    if (!activeRunId) {
      throw new Error('expected a bound coordinator run')
    }
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? WORKER_PANE_KEY
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    const task = db.createTask({ spec: 'Report once' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'runtime_test:term_worker:1',
      worktreeId: 'repo::worker',
      effects: [],
      setupState: 'not_applicable'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    const workerDone: RpcRequest = {
      id: 'rpc_worker_done',
      authToken: 'test-token',
      method: 'orchestration.send',
      params: {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: started.dispatch.id,
          outcome: 'succeeded'
        })
      },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_worker_done'
    }
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const workerMessages = () =>
      db.getInbox(100).filter((message) => message.from_handle === 'term_worker')
    return {
      db,
      runtime,
      activeRunId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      workerDone,
      dispatcher,
      workerMessages
    }
  }

  it('replays the original report when the receipt is still retained', async () => {
    const { db, taskId, dispatchId, workerDone, dispatcher, workerMessages } = setupWorker()

    // The first attempt commits, but its reply never reaches the CLI.
    const original = await dispatcher.dispatch(workerDone)
    expect(original).toMatchObject({ ok: true })
    const originalMessageId = sentMessageId(original)

    const retried = await dispatcher.dispatch({
      ...workerDone,
      id: 'rpc_worker_done_retry',
      orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
    })

    expect(retried).toMatchObject({
      ok: true,
      result: {
        message: { id: originalMessageId },
        mutation: { requestId: 'mutation_worker_done', replayed: true }
      }
    })
    expect(workerMessages()).toHaveLength(1)
    expect(db.getTask(taskId)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })

  it('refuses, without writing again, a retry whose receipt was evicted at capacity', async () => {
    const { db, activeRunId, taskId, dispatchId, workerDone, dispatcher, workerMessages } =
      setupWorker()
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    fillLedgerToOneFreeSlot(db)

    // The report takes the last slot and commits; its successful reply is lost.
    const original = await dispatcher.dispatch(workerDone)
    expect(original).toMatchObject({ ok: true })
    const originalMessageId = sentMessageId(original)
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_worker_done')?.state).toBe(
      'completed'
    )

    // A competing keyed mutation evicts the only completed receipt to make room.
    const competing = await dispatcher.dispatch({
      id: 'rpc_competing',
      authToken: 'test-token',
      method: 'orchestration.taskCreate',
      params: { spec: 'Competing work', run: activeRunId, callerTerminalHandle: 'term_coord' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_competing'
    })
    expect(competing).toMatchObject({ ok: true })
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_worker_done')).toBeUndefined()
    const ledgerBeforeRetry = receiptCount(db)

    const retried = await dispatcher.dispatch({
      ...workerDone,
      id: 'rpc_worker_done_retry',
      orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
    })

    expect(retried).toMatchObject({
      ok: false,
      error: { code: 'retry_not_replayable', data: { reason: 'receipt_absent' } }
    })
    const messages = workerMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: originalMessageId, type: 'worker_done' })
    expect(db.getTask(taskId)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_worker_done')).toBeUndefined()
    expect(receiptCount(db)).toBe(ledgerBeforeRetry)
  })

  it('refuses a contract it does not know before any effect, as an older runtime refuses replay-only', async () => {
    const { db, activeRunId, workerDone, dispatcher, workerMessages } = setupWorker()
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    fillLedgerToOneFreeSlot(db)
    const original = await dispatcher.dispatch(workerDone)
    const originalMessageId = sentMessageId(original)
    await dispatcher.dispatch({
      id: 'rpc_competing',
      authToken: 'test-token',
      method: 'orchestration.taskCreate',
      params: { spec: 'Competing work', run: activeRunId, callerTerminalHandle: 'term_coord' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_competing'
    })
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_worker_done')).toBeUndefined()

    // A runtime that predates replay-only takes it as an unknown contract, the same refusal.
    const retried = await dispatcher.dispatch({
      ...workerDone,
      id: 'rpc_worker_done_retry',
      orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION + 1
    })

    expect(retried).toMatchObject({
      ok: false,
      error: { code: 'orchestration_migration_required' }
    })
    expect(workerMessages().map((message) => message.id)).toEqual([originalMessageId])
  })

  it.each([
    ['an ordinary send', { type: 'status', to: 'term_coord' }, 'orchestration.send'],
    ['a mailbox check', { terminal: 'term_worker' }, 'orchestration.check']
  ])(
    'admits replay-only for a keyed worker_done only, refusing %s',
    async (_case, extra, method) => {
      const { workerDone, dispatcher, workerMessages } = setupWorker()
      const params = isRecord(workerDone.params) ? workerDone.params : {}

      const refused = await dispatcher.dispatch({
        ...workerDone,
        method,
        params: { ...params, ...extra },
        orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
      })

      expect(refused).toMatchObject({
        ok: false,
        error: { code: 'orchestration_migration_required' }
      })
      expect(workerMessages()).toHaveLength(0)
    }
  )

  it('rejects replay-only before a valid legacy ask can create mail or authority', async () => {
    const { db, runtime, activeRunId, dispatchId, dispatcher, workerMessages } = setupWorker()
    db.db
      .prepare('UPDATE dispatch_contexts SET contract_version = ? WHERE id = ?')
      .run(LEGACY_CONTRACT_VERSION, dispatchId)
    db.db
      .prepare(
        'INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost) VALUES (?, ?, 1)'
      )
      .run(ORCHESTRATION_LEGACY_RUN_ID, activeRunId)
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      hostScope: { kind: 'local', hostId: 'local' },
      paneKey: WORKER_PANE_KEY,
      terminalHandle: 'term_worker',
      processIncarnation: 'runtime_test:term_worker:1',
      launchTokenHash: 'fixture-token-hash'
    })
    const ask = {
      authToken: 'test-token',
      method: 'orchestration.ask',
      params: {
        from: 'term_worker',
        to: 'term_coord',
        question: 'Which option?',
        compatibilityWindowsCommand: 'orca'
      },
      orchestrationRequestId: 'mutation_legacy_ask'
    }
    const effects = () =>
      db.db
        .prepare(`SELECT
      (SELECT count(*) FROM legacy_compatibility_principals) AS principals,
      (SELECT count(*) FROM legacy_operation_receipts) AS operations,
      (SELECT count(*) FROM question_threads) AS questions`)
        .get()

    const refused = await dispatcher.dispatch({
      ...ask,
      id: 'replay',
      orchestrationContractVersion: 2
    })

    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'orchestration_migration_required' }
    })
    expect(effects()).toEqual({ principals: 0, operations: 0, questions: 0 })
    expect(workerMessages()).toHaveLength(0)

    const original = await dispatcher.dispatch({
      ...ask,
      id: 'original',
      orchestrationContractVersion: 1
    })

    expect(original).toMatchObject({
      ok: true,
      result: { legacyCompatibility: { resumeRequired: true } }
    })
    expect(effects()).toEqual({ principals: 1, operations: 1, questions: 1 })
    expect(workerMessages()).toHaveLength(1)
  })

  describe('from a paired computer that coordinates a Run here', () => {
    const PEER = {
      authenticatedCallerFingerprint: 'fingerprint_peer',
      pairedDeviceId: 'device_peer',
      clientKind: 'runtime'
    } as const
    const peerRun = (conversationId: string, label: string) => ({
      runId: 'run_on_peer',
      conversationId,
      label
    })
    const peerState = (db: OrchestrationDb, conversationId: string) => {
      const run = db.getPeerRunForConversation(conversationId)
      return {
        conversation: db.getPeerMailConversation(conversationId) ?? null,
        peerRun: run ?? null,
        run: run ? (db.getRunRaw(run.run_id) ?? null) : null
      }
    }

    it('refuses a replay-only retry with a new peer Run before writing its conversation or Run', async () => {
      const { db, workerDone, dispatcher, workerMessages } = setupWorker()
      const conversationId = 'peerconv_bbbbbbbbbbbb'
      const receiptsBefore = receiptCount(db)

      const refused = await dispatcher.dispatch(
        {
          ...workerDone,
          id: 'rpc_peer_replay',
          orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION,
          orchestrationPeerRun: peerRun(conversationId, 'Home Run')
        },
        PEER
      )

      // State first: a refusal after the peer writer would still have committed these rows.
      expect(peerState(db, conversationId)).toEqual({
        conversation: null,
        peerRun: null,
        run: null
      })
      expect(receiptCount(db)).toBe(receiptsBefore)
      expect(workerMessages()).toHaveLength(0)
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: 'orchestration_migration_required',
          data: { reason: 'client_contract_unsupported' }
        }
      })
    })

    it('leaves an existing peer Run, its label and its restored Run untouched', async () => {
      const { db, workerDone, dispatcher, workerMessages } = setupWorker()
      const conversationId = 'peerconv_cccccccccccc'
      // v1 peer admission still writes the peer Run, so the refusal below is the v2 fence alone.
      const v1 = await dispatcher.dispatch(
        {
          ...workerDone,
          id: 'rpc_peer_original',
          orchestrationRequestId: 'mutation_peer_original',
          orchestrationPeerRun: peerRun(conversationId, 'Home Run')
        },
        PEER
      )
      expect(v1).not.toMatchObject({ error: { code: 'orchestration_migration_required' } })
      const admitted = peerState(db, conversationId)
      expect(admitted.peerRun).toMatchObject({ home_label: 'Home Run', home_run_id: 'run_on_peer' })
      expect(admitted.run).not.toBeNull()
      // A reset here removed the Run row; only a real peer call may restore it.
      db.db.prepare('DELETE FROM runs WHERE id = ?').run(admitted.peerRun?.run_id)
      const before = peerState(db, conversationId)
      expect(before.run).toBeNull()
      const receiptsBefore = receiptCount(db)
      const messagesBefore = workerMessages().map((message) => message.id)

      const refused = await dispatcher.dispatch(
        {
          ...workerDone,
          id: 'rpc_peer_replay',
          orchestrationRequestId: 'mutation_peer_absent',
          orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION,
          orchestrationPeerRun: peerRun(conversationId, 'Renamed Run')
        },
        PEER
      )

      expect(peerState(db, conversationId)).toEqual(before)
      expect(receiptCount(db)).toBe(receiptsBefore)
      expect(workerMessages().map((message) => message.id)).toEqual(messagesBefore)
      expect(refused).toMatchObject({
        ok: false,
        error: { code: 'orchestration_migration_required' }
      })
    })
  })

  it.each([undefined, ''])('refuses a replay-only request with key %j', async (key) => {
    const { workerDone, dispatcher, workerMessages } = setupWorker()

    const refused = await dispatcher.dispatch({
      ...workerDone,
      orchestrationRequestId: key,
      orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
    })

    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'orchestration_migration_required' }
    })
    expect(workerMessages()).toHaveLength(0)
  })
})
