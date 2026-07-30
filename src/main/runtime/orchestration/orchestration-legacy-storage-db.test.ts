import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  CURRENT_CONTRACT_VERSION,
  LEGACY_CONTRACT_VERSION,
  LEGACY_RUN_ID,
  OrchestrationDb
} from './db'
import {
  createLegacyStorageCutoverFixture,
  type LegacyStorageCutoverFixture
} from './orchestration-legacy-storage-test-fixture'

describe('OrchestrationDb legacy contract storage', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createCutoverFixture(): LegacyStorageCutoverFixture {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    return created.fixture
  }

  function openAdoptedFixture(): {
    fixture: LegacyStorageCutoverFixture
    adoptedRunId: string
    workerPrincipalId: string
    coordinatorPrincipalId: string
  } {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const worker = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      dispatchId: fixture.legacyDispatchId,
      role: 'worker',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_worker',
      paneKey: 'tab_legacy:33333333-3333-4333-8333-333333333333',
      launchTokenHash: 'legacy_launch_hash',
      processIncarnation: 'process_1'
    })
    const coordinator = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    })
    return {
      fixture,
      adoptedRunId,
      workerPrincipalId: worker.principal.id,
      coordinatorPrincipalId: coordinator.principal.id
    }
  }

  it('atomically rehomes the full graph, fences legacy Delivery, and preserves current rows', () => {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoption = db.getLegacyAdoption()
    const adoptedRunId = adoption?.adopted_run_id as string
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(adoption).toMatchObject({
      source_run_id: LEGACY_RUN_ID,
      scheduler_state_lost: 1
    })
    expect(db.getRun(adoptedRunId)).toMatchObject({ legacy: 0, consumer_generation: 0 })
    expect(db.listTasks({ runId: LEGACY_RUN_ID })).toEqual([])
    expect(db.getDispatchContextById(fixture.legacyDispatchId)).toMatchObject({
      run_id: adoptedRunId,
      contract_version: LEGACY_CONTRACT_VERSION,
      launch_token_hash: null
    })
    expect(db.getGate(fixture.legacyGateId)).toMatchObject({ run_id: adoptedRunId })
    expect(db.getQuestion(fixture.legacyQuestionId)).toMatchObject({ run_id: adoptedRunId })
    expect(db.getMessageById(fixture.legacyMessageIds[0])).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'legacy_direct'
    })
    expect(db.getMessageById(fixture.rejectionMessageId)).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'audit_only'
    })
    expect(db.getMessageById(fixture.lookalikeMessageId)).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'legacy_direct'
    })
    for (const messageId of fixture.malformedRejectionMessageIds) {
      expect(db.getMessageById(messageId)).toMatchObject({
        run_id: adoptedRunId,
        delivery_contract: 'legacy_direct'
      })
    }
    expect(
      sqlite.prepare('SELECT * FROM deliveries WHERE id = ?').get(fixture.legacyDeliveryId)
    ).toMatchObject({ run_id: adoptedRunId, status: 'fenced' })
    expect(db.getDispatchContextById(fixture.currentDispatchId)).toMatchObject({
      run_id: fixture.currentRunId,
      contract_version: CURRENT_CONTRACT_VERSION,
      launch_token_hash: 'current_launch_hash'
    })

    db.close()
    const partial = new Database(fixture.dbPath)
    partial
      .prepare('UPDATE tasks SET run_id = ? WHERE id = ?')
      .run(LEGACY_RUN_ID, fixture.legacyTaskId)
    partial.pragma('user_version = 19')
    partial.close()
    db = new OrchestrationDb(fixture.dbPath)
    expect(db.getLegacyAdoption()?.adopted_run_id).toBe(adoptedRunId)
    expect(db.getTask(fixture.legacyTaskId)?.run_id).toBe(adoptedRunId)
    expect(db.getDispatchContextById(fixture.currentDispatchId)?.contract_version).toBe(
      CURRENT_CONTRACT_VERSION
    )
    expect(db.listTasks({ runId: LEGACY_RUN_ID })).toEqual([])
  })

  it('ignores unrelated cross-Run anomalies while validating adopted rows', () => {
    const fixture = createCutoverFixture()
    const raw = new Database(fixture.dbPath)
    raw
      .prepare('UPDATE dispatch_contexts SET run_id = ? WHERE id = ?')
      .run(fixture.unrelatedRunId, fixture.currentDispatchId)
    raw.close()

    db = new OrchestrationDb(fixture.dbPath)

    expect(db.getLegacyAdoption()).toBeDefined()
    expect(db.getDispatchContextById(fixture.currentDispatchId)?.run_id).toBe(
      fixture.unrelatedRunId
    )
  })

  it('does not synthesize an adopted Run or compatibility authority for a fresh database', () => {
    db = new OrchestrationDb(':memory:')

    expect(db.getLegacyAdoption()).toBeUndefined()
    expect(db.listLegacyCompatibilityPrincipals(LEGACY_RUN_ID)).toEqual([])
    expect(db.listRuns()).toEqual([expect.objectContaining({ id: LEGACY_RUN_ID, legacy: 1 })])
  })

  it('keeps current Delivery disjoint from adopted direct and audit-only mail', () => {
    const state = openAdoptedFixture()
    const run = db!.getRun(state.adoptedRunId) as NonNullable<ReturnType<OrchestrationDb['getRun']>>
    db!.insertMessage({
      runId: state.adoptedRunId,
      from: 'current_worker',
      to: `run:${state.adoptedRunId}`,
      subject: 'current retry mail'
    })

    const delivery = db!.getOrCreateRunDelivery({
      runId: state.adoptedRunId,
      consumerGeneration: run.consumer_generation
    })

    expect(delivery?.messages.map((message) => message.subject)).toEqual(['current retry mail'])
  })

  it('drains a durable recovery cohort in bounded replaying pages before unread mail', () => {
    const state = openAdoptedFixture()
    const first = db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 })
    const replay = db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 })

    expect(first.recovery).toBe(true)
    expect(replay.messages.map((message) => message.id)).toEqual(
      first.messages.map((message) => message.id)
    )
    expect(() =>
      db!.acknowledgeLegacyMail({
        principalId: state.workerPrincipalId,
        messageIds: [state.fixture.legacyMessageIds[2]]
      })
    ).toThrow(/current replay page/)
    db!.acknowledgeLegacyMail({
      principalId: state.workerPrincipalId,
      messageIds: first.messages.map((message) => message.id)
    })
    const second = db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 })
    expect(second.recovery).toBe(true)
    expect(second.messages[0].id).not.toBe(first.messages[0].id)
    db!.acknowledgeLegacyMail({
      principalId: state.workerPrincipalId,
      messageIds: second.messages.map((message) => message.id)
    })
    expect(db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 }).recovery).toBe(
      false
    )
  })

  it('returns complete addressed legacy history without changing read state', () => {
    const state = openAdoptedFixture()
    const unread = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_coord',
      to: 'term_legacy_worker',
      subject: 'unread history'
    })
    db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'other',
      to: 'other',
      subject: 'not addressed'
    })

    const history = db!.getLegacyMailHistory({ principalId: state.workerPrincipalId })

    expect(history.recovery).toBe(false)
    expect(history.messages.map((message) => message.subject)).toEqual([
      'read worker mail',
      'second worker page',
      'unread history'
    ])
    expect(db!.getMessageById(unread.id)?.read).toBe(0)
  })

  it('resolves legacy principals and completion evidence only within exact assignments', () => {
    const state = openAdoptedFixture()
    const taskId = db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id
    const payload = JSON.stringify({ taskId, dispatchId: state.fixture.legacyDispatchId })
    const completion = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed',
      body: 'done',
      type: 'worker_done',
      payload
    })

    expect(
      db!.resolveLegacyWorkerCandidate({
        runId: state.adoptedRunId,
        terminalHandle: 'term_legacy_worker',
        paneKey: 'tab_reminted:33333333-3333-4333-8333-333333333333',
        taskId
      })
    ).toMatchObject({ dispatch: { id: state.fixture.legacyDispatchId } })
    expect(
      db!.resolveLegacyWorkerCandidate({
        runId: state.adoptedRunId,
        terminalHandle: 'term_legacy_worker',
        paneKey: 'tab_wrong:99999999-9999-4999-8999-999999999999',
        taskId
      })
    ).toBeUndefined()
    expect(
      db!.resolveLegacyCoordinatorCandidate({
        runId: state.adoptedRunId,
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444'
      })
    ).toMatchObject({ terminalHandle: 'term_legacy_coord' })
    expect(
      db!.findLegacyWorkerCompletion({
        principalId: state.workerPrincipalId,
        taskId,
        recipientHandle: 'term_legacy_coord',
        subject: 'Completed',
        body: 'done',
        payload
      })
    ).toMatchObject({ id: completion.id })
  })

  it('prevents an unproven coordinator from taking over an active adopted Run', () => {
    const state = openAdoptedFixture()
    expect(() =>
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_other',
        coordinatorPaneKey: 'tab_other:55555555-5555-4555-8555-555555555555'
      })
    ).toThrow(/attested coordinator may rebind/)

    const bound = db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_legacy_coord',
      coordinatorPaneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      legacyCoordinatorAuthority: {
        runId: state.adoptedRunId,
        principalId: state.coordinatorPrincipalId,
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
        consumerGeneration: 0
      }
    })
    expect(bound).toMatchObject({ coordinator_handle: 'term_legacy_coord' })
    expect(
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_legacy_coord',
        coordinatorPaneKey: 'tab_coord:44444444-4444-4444-8444-444444444444'
      })
    ).toMatchObject({ coordinator_handle: 'term_legacy_coord' })
  })

  it.each([
    ['generation', { consumerGeneration: 1 }],
    ['principal', { principalId: 'legacy_principal_wrong' }],
    ['handle', { terminalHandle: 'term_wrong' }],
    ['pane', { paneKey: 'tab_wrong:99999999-9999-4999-8999-999999999999' }]
  ] as const)('rejects stale legacy coordinator %s proof inside Run binding', (_label, patch) => {
    const state = openAdoptedFixture()
    const before = db!.getRun(state.adoptedRunId)

    expect(() =>
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_legacy_coord',
        coordinatorPaneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
        legacyCoordinatorAuthority: {
          runId: state.adoptedRunId,
          principalId: state.coordinatorPrincipalId,
          terminalHandle: 'term_legacy_coord',
          paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
          consumerGeneration: 0,
          ...patch
        }
      })
    ).toThrow(/no longer has lifecycle authority/)
    expect(db!.getRun(state.adoptedRunId)).toEqual(before)
  })

  it('revokes the legacy coordinator when a current coordinator takes over after settlement', () => {
    const state = openAdoptedFixture()
    db!.settleWorkerReport({
      taskId: state.fixture.legacyTaskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'done'
    })

    expect(
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_current_coord',
        coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111'
      })
    ).toMatchObject({ coordinator_handle: 'term_current_coord' })
    expect(db!.getLegacyCompatibilityPrincipal(state.coordinatorPrincipalId)?.status).toBe(
      'revoked'
    )
    expect(() =>
      db!.commitLegacyCompatibilityPrincipal({
        runId: state.adoptedRunId,
        role: 'coordinator',
        hostScope: 'local:runtime_1',
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
        launchTokenHash: 'coord_launch_hash',
        processIncarnation: 'process_coord'
      })
    ).toThrow(/revoked/)
  })

  it('promotes only mail addressed to the replaced legacy coordinator', () => {
    const state = openAdoptedFixture()
    const coordinatorMail = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'coordinator outcome'
    })
    const workerMail = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_other_worker',
      subject: 'worker-only guidance'
    })

    db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })

    expect(db!.getMessageById(coordinatorMail.id)).toMatchObject({
      to_handle: `run:${state.adoptedRunId}`,
      delivery_contract: 'current_delivery'
    })
    expect(db!.getMessageById(workerMail.id)).toMatchObject({
      to_handle: 'term_other_worker',
      delivery_contract: 'legacy_direct'
    })
  })

  it('commits legacy messages, lifecycle effects, and invocation receipts exactly once', () => {
    const state = openAdoptedFixture()
    const params = {
      principalId: state.workerPrincipalId,
      operationKey: 'invocation_1',
      method: 'orchestration.send',
      payloadHash: 'payload_1',
      message: {
        to: 'term_legacy_coord',
        subject: 'alive',
        type: 'heartbeat' as const
      },
      lifecycle: { kind: 'heartbeat' as const, at: '2026-07-28T12:00:00.000Z' }
    }

    const first = db!.commitLegacyLifecycleOperation(params)
    const replay = db!.commitLegacyLifecycleOperation(params)

    expect(replay).toMatchObject({
      duplicate: true,
      message: { id: first.message.id },
      receipt: { effect_id: first.message.id }
    })
    expect(db!.getDispatchContextById(state.fixture.legacyDispatchId)?.last_heartbeat_at).toBe(
      '2026-07-28T12:00:00.000Z'
    )
    expect(db!.getUnreadMessages('term_legacy_coord')).toEqual([])
    expect(db!.getUndeliveredUnreadMessages('term_legacy_coord')).toEqual([])
    expect(() =>
      db!.commitLegacyLifecycleOperation({ ...params, payloadHash: 'different' })
    ).toThrow(/different input/)
  })

  it('reconstructs a matching pre-receipt settlement without changing its persisted outcome', () => {
    const state = openAdoptedFixture()
    const accepted = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed',
      type: 'worker_done'
    })
    expect(
      db!.settleWorkerReport({
        taskId: db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id,
        dispatchId: state.fixture.legacyDispatchId,
        outcome: 'succeeded',
        result: 'accepted by A'
      })
    ).toMatchObject({ action: 'settled', duplicate: false })

    const reconstructed = db!.commitLegacyLifecycleOperation({
      principalId: state.workerPrincipalId,
      operationKey: `settlement:${state.fixture.legacyDispatchId}`,
      method: 'orchestration.send',
      payloadHash: 'settlement_payload',
      message: {
        existingId: accepted.id,
        to: 'term_legacy_coord',
        subject: 'Completed',
        type: 'worker_done'
      },
      lifecycle: {
        kind: 'worker_report',
        taskId: db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id,
        outcome: 'succeeded',
        result: 'accepted by A'
      }
    })

    expect(reconstructed).toMatchObject({
      duplicate: false,
      message: { id: accepted.id },
      settlement: { action: 'settled', outcome: 'succeeded', duplicate: true }
    })
    expect(db!.getLegacyCompatibilityPrincipal(state.workerPrincipalId)?.status).toBe('settled')
  })

  it('reconstructs a read pre-takeover completion through its original legacy route', () => {
    const state = openAdoptedFixture()
    const taskId = db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id
    const accepted = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed',
      body: 'accepted before takeover',
      type: 'worker_done'
    })
    db!.markAsRead([accepted.id])
    db!.settleWorkerReport({
      taskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'accepted before takeover'
    })
    db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })
    const beforeIds = db!.getInbox(100).map((message) => message.id)

    const reconstructed = db!.commitLegacyLifecycleOperation({
      principalId: state.workerPrincipalId,
      operationKey: 'read_completion_after_takeover',
      method: 'orchestration.send',
      payloadHash: 'read_completion_after_takeover_payload',
      message: {
        existingId: accepted.id,
        to: 'term_legacy_coord',
        subject: 'Completed',
        body: 'accepted before takeover',
        type: 'worker_done'
      },
      lifecycle: {
        kind: 'worker_report',
        taskId,
        outcome: 'succeeded',
        result: 'accepted before takeover'
      }
    })

    expect(reconstructed).toMatchObject({
      duplicate: false,
      message: {
        id: accepted.id,
        to_handle: 'term_legacy_coord',
        delivery_contract: 'legacy_direct'
      },
      settlement: { action: 'settled', outcome: 'succeeded', duplicate: true }
    })
    expect(db!.getInbox(100).map((message) => message.id)).toEqual(beforeIds)
  })

  it('rejects cross-cutover completion reconstruction for another recipient', () => {
    const state = openAdoptedFixture()
    const taskId = db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id
    const payload = JSON.stringify({ taskId, dispatchId: state.fixture.legacyDispatchId })
    const foreign = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_other_coord',
      subject: 'Completed',
      body: 'accepted elsewhere',
      type: 'worker_done',
      payload
    })
    db!.settleWorkerReport({
      taskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'accepted elsewhere'
    })
    const beforeIds = db!.getInbox(100).map((message) => message.id)

    expect(
      db!.findLegacyWorkerCompletion({
        principalId: state.workerPrincipalId,
        taskId,
        recipientHandle: 'term_legacy_coord',
        subject: 'Completed',
        body: 'accepted elsewhere',
        payload
      })
    ).toBeUndefined()
    expect(() =>
      db!.commitLegacyLifecycleOperation({
        principalId: state.workerPrincipalId,
        operationKey: 'wrong_recipient_retry',
        method: 'orchestration.send',
        payloadHash: 'wrong_recipient_retry_payload',
        message: {
          to: 'term_legacy_coord',
          subject: 'Completed',
          body: 'accepted elsewhere',
          type: 'worker_done',
          payload
        },
        lifecycle: {
          kind: 'worker_report',
          taskId,
          outcome: 'succeeded',
          result: 'accepted elsewhere'
        }
      })
    ).toThrow(/settled/)
    expect(() =>
      db!.commitLegacyLifecycleOperation({
        principalId: state.workerPrincipalId,
        operationKey: 'wrong_recipient_reconstruction',
        method: 'orchestration.send',
        payloadHash: 'wrong_recipient_payload',
        message: {
          existingId: foreign.id,
          to: 'term_legacy_coord',
          subject: 'Completed',
          body: 'accepted elsewhere',
          type: 'worker_done',
          payload
        },
        lifecycle: {
          kind: 'worker_report',
          taskId,
          outcome: 'succeeded',
          result: 'accepted elsewhere'
        }
      })
    ).toThrow(/does not match this principal/)
    expect(db!.getInbox(100).map((message) => message.id)).toEqual(beforeIds)
    expect(
      db!.getLegacyOperationReceipt(state.workerPrincipalId, 'wrong_recipient_reconstruction')
    ).toBeUndefined()
    expect(
      db!.getLegacyOperationReceipt(state.workerPrincipalId, 'wrong_recipient_retry')
    ).toBeUndefined()
    expect(db!.getTask(taskId)).toMatchObject({
      status: 'completed',
      result: 'accepted elsewhere'
    })
  })

  it('uses invocation identity for repeated asks and atomically conflicts divergent replies', () => {
    const state = openAdoptedFixture()
    const ask = {
      principalId: state.workerPrincipalId,
      operationKey: 'ask_invocation_1',
      method: 'orchestration.ask',
      payloadHash: 'ask_payload',
      question: 'Same text?',
      options: ['yes', 'no'],
      recipientHandle: 'term_legacy_coord'
    }
    const first = db!.commitLegacyAskOperation(ask)
    const replay = db!.commitLegacyAskOperation(ask)
    const repeated = db!.commitLegacyAskOperation({
      ...ask,
      operationKey: 'ask_invocation_2'
    })

    expect(replay).toMatchObject({ duplicate: true, question: { message_id: first.message.id } })
    expect(repeated.message.id).not.toBe(first.message.id)
    expect(db!.findPendingLegacyQuestions(ask)).toHaveLength(2)
    expect(
      db!.findPendingLegacyQuestions({
        ...ask,
        question: '  Same text?\r\n',
        options: ['yes ', ' no']
      })
    ).toHaveLength(2)

    const inherited = db!.createQuestion({
      runId: state.adoptedRunId,
      dispatchId: state.fixture.legacyDispatchId,
      askerHandle: 'term_legacy_worker',
      question: 'Inherited?'
    })
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        `UPDATE messages
         SET from_handle = 'term_legacy_worker', to_handle = 'term_legacy_coord',
             delivery_contract = 'legacy_direct'
         WHERE id = ?`
      )
      .run(inherited.message.id)
    const inheritedAsk = {
      ...ask,
      operationKey: 'ask_inherited_1',
      payloadHash: 'ask_inherited_payload_1',
      question: 'Inherited?',
      options: [],
      existingQuestionId: inherited.message.id
    }
    const adopted = db!.commitLegacyAskOperation(inheritedAsk)
    const distinct = db!.commitLegacyAskOperation({
      ...inheritedAsk,
      operationKey: 'ask_inherited_2',
      payloadHash: 'ask_inherited_payload_2'
    })
    expect(adopted.message.id).toBe(inherited.message.id)
    expect(distinct.message.id).not.toBe(inherited.message.id)

    const reply = {
      principalId: state.coordinatorPrincipalId,
      operationKey: 'reply_invocation_1',
      method: 'orchestration.reply',
      payloadHash: 'reply_payload',
      questionId: first.message.id,
      body: 'yes'
    }
    const answered = db!.commitLegacyReplyOperation(reply)
    const answerReplay = db!.commitLegacyReplyOperation(reply)
    expect(answerReplay).toMatchObject({
      duplicate: true,
      message: { id: answered.message.id }
    })
    expect(
      db!
        .findLegacyQuestionsBySemanticIdentity(ask)
        .find((row) => row.question.message_id === first.message.id)
    ).toMatchObject({ question: { status: 'answered' }, answerAcknowledged: false })
    db!.acknowledgeLegacyQuestionAnswer({
      principalId: state.workerPrincipalId,
      questionId: first.message.id,
      answerMessageId: answered.message.id
    })
    expect(
      db!
        .findLegacyQuestionsBySemanticIdentity(ask)
        .find((row) => row.question.message_id === first.message.id)
    ).toMatchObject({ answerAcknowledged: true })
    expect(() =>
      db!.commitLegacyReplyOperation({
        ...reply,
        operationKey: 'reply_invocation_2',
        payloadHash: 'different_reply',
        body: 'no'
      })
    ).toThrow(/different answer/)

    const currentTask = db!.createTask({ runId: state.adoptedRunId, spec: 'current retry' })
    const currentDispatch = db!.createDispatchContext(currentTask.id, 'term_current_retry')
    const currentQuestion = db!.createQuestion({
      runId: state.adoptedRunId,
      dispatchId: currentDispatch.id,
      askerHandle: 'term_current_retry',
      question: 'Current question?'
    })
    expect(() =>
      db!.commitLegacyReplyOperation({
        ...reply,
        operationKey: 'reply_current_question',
        payloadHash: 'current_question',
        questionId: currentQuestion.message.id
      })
    ).toThrow(/not actionable/)
  })
})
