import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import {
  createLegacyStorageCutoverFixture,
  type LegacyStorageCutoverFixture
} from './orchestration-legacy-storage-test-fixture'

describe('OrchestrationDb legacy coordinator authority', () => {
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
    return {
      fixture,
      adoptedRunId,
      workerPrincipalId: worker.principal.id
    }
  }

  it('records exact scheduler loss without admitting naturally settled coordinators', () => {
    const fixture = createCutoverFixture()
    const raw = new Database(fixture.dbPath)
    raw.exec(`
      UPDATE tasks
      SET created_by_terminal_handle = 'term_manual_coord'
      WHERE run_id = '${LEGACY_RUN_ID}';
      UPDATE messages
      SET from_handle = CASE
            WHEN from_handle = 'term_legacy_coord' THEN 'term_manual_coord'
            ELSE from_handle
          END,
          to_handle = CASE
            WHEN to_handle = 'term_legacy_coord' THEN 'term_manual_coord'
            ELSE to_handle
          END
      WHERE run_id = '${LEGACY_RUN_ID}';
      INSERT INTO coordinator_runs (
        id, spec, status, coordinator_handle, created_at
      ) VALUES (
        'coordinator_manual', 'manual legacy coordinator', 'running',
        'term_manual_coord', datetime('now', '-1 minute')
      );
      INSERT INTO coordinator_runs (
        id, spec, status, coordinator_handle, created_at, completed_at
      ) VALUES (
        'coordinator_natural', 'naturally completed coordinator', 'completed',
        'term_natural_coord', datetime('now', '-2 minutes'),
        '2099-01-01T00:00:00.000Z'
      );
    `)
    raw.close()

    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    expect(db.getActiveCoordinatorRun()).toBeUndefined()
    const adoption = db.getLegacyAdoption()!
    const migratedCoordinator = db.getCoordinatorRun('coordinator_manual')!
    expect(migratedCoordinator).toMatchObject({
      status: 'failed',
      completed_at: adoption.adopted_at,
      scheduler_lost_at: adoption.adopted_at
    })
    expect(db.getCoordinatorRun('coordinator_natural')).toMatchObject({
      status: 'completed',
      completed_at: '2099-01-01T00:00:00.000Z',
      scheduler_lost_at: null
    })
    expect(
      db.resolveLegacyCoordinatorCandidate({
        runId: adoptedRunId,
        terminalHandle: 'term_manual_coord',
        paneKey: 'tab_manual:44444444-4444-4444-8444-444444444444'
      })
    ).toMatchObject({ terminalHandle: 'term_manual_coord' })
    expect(db.isLegacyCoordinatorHandle(adoptedRunId, 'term_natural_coord')).toBe(false)

    db.close()
    db = new OrchestrationDb(fixture.dbPath)
    expect(db.getLegacyAdoption()).toEqual(adoption)
    expect(db.getCoordinatorRun('coordinator_manual')).toEqual(migratedCoordinator)
    expect(
      db.resolveLegacyCoordinatorCandidate({
        runId: adoptedRunId,
        terminalHandle: 'term_manual_coord',
        paneKey: 'tab_manual:44444444-4444-4444-8444-444444444444'
      })
    ).toMatchObject({ terminalHandle: 'term_manual_coord' })
  })

  it('fails closed when multiple pre-cutover schedulers lose authority', () => {
    const fixture = createCutoverFixture()
    const raw = new Database(fixture.dbPath)
    raw.exec(`
      INSERT INTO coordinator_runs (
        id, spec, status, coordinator_handle, created_at
      ) VALUES
        ('coordinator_first', 'first', 'running', 'term_first_coord', datetime('now', '-2 minutes')),
        ('coordinator_second', 'second', 'running', 'term_second_coord', datetime('now', '-1 minute'));
    `)
    raw.close()

    db = new OrchestrationDb(fixture.dbPath)
    const adoption = db.getLegacyAdoption()!
    const adoptedRunId = adoption.adopted_run_id
    expect(db.getActiveCoordinatorRun()).toBeUndefined()
    expect(db.getCoordinatorRun('coordinator_first')).toMatchObject({
      status: 'failed',
      scheduler_lost_at: adoption.adopted_at
    })
    expect(db.getCoordinatorRun('coordinator_second')).toMatchObject({
      status: 'failed',
      scheduler_lost_at: adoption.adopted_at
    })
    expect(
      db.resolveLegacyCoordinatorCandidate({
        runId: adoptedRunId,
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_manual:44444444-4444-4444-8444-444444444444'
      })
    ).toBeUndefined()
  })

  it('does not infer a coordinator from worker-to-worker legacy mail', () => {
    const fixture = createCutoverFixture()
    const raw = new Database(fixture.dbPath)
    raw.exec(`
      INSERT INTO tasks (
        id, run_id, spec, status, created_by_terminal_handle
      ) VALUES (
        'task_second_worker', '${LEGACY_RUN_ID}', 'second worker',
        'dispatched', 'term_legacy_coord'
      );
      INSERT INTO dispatch_contexts (
        id, run_id, task_id, contract_version, assignee_handle,
        assignee_pane_key, status, dispatched_at
      ) VALUES (
        'dispatch_second_worker', '${LEGACY_RUN_ID}', 'task_second_worker', 0,
        'term_second_worker', 'tab_second:55555555-5555-4555-8555-555555555555',
        'dispatched', datetime('now')
      );
      INSERT INTO messages (
        id, run_id, from_handle, to_handle, subject
      ) VALUES (
        'message_worker_to_worker', '${LEGACY_RUN_ID}', 'term_legacy_worker',
        'term_second_worker', 'peer coordination'
      );
    `)
    raw.close()

    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    expect(db.isLegacyCoordinatorHandle(adoptedRunId, 'term_second_worker')).toBe(false)
    expect(db.isLegacyCoordinatorHandle(adoptedRunId, 'term_legacy_worker')).toBe(false)
    expect(db.isLegacyCoordinatorHandle(adoptedRunId, 'term_legacy_coord')).toBe(true)
  })

  it('promotes only the unacknowledged coordinator recovery cohort during takeover', () => {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const unacknowledged = db.insertMessage({
      runId: adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'second recovered coordinator outcome'
    })
    db.markAsRead([unacknowledged.id])
    const coordinator = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    }).principal
    const firstPage = db.getLegacyMailPage({ principalId: coordinator.id, limit: 1 })
    expect(firstPage.recovery).toBe(true)
    db.acknowledgeLegacyMail({
      principalId: coordinator.id,
      messageIds: firstPage.messages.map((message) => message.id)
    })
    const acknowledgedId = firstPage.messages[0].id

    db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })

    expect(db.getMessageById(acknowledgedId)).toMatchObject({
      to_handle: 'term_legacy_coord',
      delivery_contract: 'legacy_direct',
      read: 1
    })
    expect(db.getMessageById(unacknowledged.id)).toMatchObject({
      to_handle: `run:${adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })
  })

  it('promotes a pre-cutover read recovery message when takeover precedes attestation', () => {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const recoveryMessageId = fixture.legacyMessageIds[1]
    expect(db.getLegacyCoordinatorPrincipal(adoptedRunId)).toBeUndefined()
    expect(db.getMessageById(recoveryMessageId)).toMatchObject({
      to_handle: 'term_legacy_coord',
      delivery_contract: 'legacy_direct',
      read: 1
    })

    const run = db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })!
    expect(db.getMessageById(recoveryMessageId)).toMatchObject({
      to_handle: `run:${adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })

    const first = db.getOrCreateRunDelivery({
      runId: adoptedRunId,
      consumerGeneration: run.consumer_generation
    })!
    const replay = db.getOrCreateRunDelivery({
      runId: adoptedRunId,
      consumerGeneration: run.consumer_generation
    })!
    expect(first.messages.map((message) => message.id)).toContain(recoveryMessageId)
    expect(replay).toMatchObject({ replayed: true, delivery: { id: first.delivery.id } })

    db.acknowledgeRunDelivery({
      runId: adoptedRunId,
      consumerGeneration: run.consumer_generation,
      deliveryId: first.delivery.id
    })
    expect(
      db
        .getOrCreateRunDelivery({
          runId: adoptedRunId,
          consumerGeneration: run.consumer_generation
        })
        ?.messages.map((message) => message.id) ?? []
    ).not.toContain(recoveryMessageId)
  })

  it('promotes retained mail on an ordinary post-settlement coordinator replacement', () => {
    const state = openAdoptedFixture()
    const coordinator = db!.commitLegacyCompatibilityPrincipal({
      runId: state.adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    }).principal
    const completion = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed before ordinary run-use',
      type: 'worker_done'
    })
    db!.settleWorkerReport({
      taskId: state.fixture.legacyTaskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'done'
    })

    const run = db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111'
    })!

    expect(db!.getLegacyCompatibilityPrincipal(coordinator.id)?.status).toBe('revoked')
    expect(db!.getMessageById(completion.id)).toMatchObject({
      to_handle: `run:${state.adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })
    expect(
      db!
        .getOrCreateRunDelivery({
          runId: state.adoptedRunId,
          consumerGeneration: run.consumer_generation
        })
        ?.messages.map((message) => message.id)
    ).toContain(completion.id)
  })

  it('acknowledges the exact current Run answer to a legacy ask after takeover', () => {
    const state = openAdoptedFixture()
    const ask = db!.commitLegacyAskOperation({
      principalId: state.workerPrincipalId,
      operationKey: 'ask_before_takeover',
      method: 'orchestration.ask',
      payloadHash: 'ask_before_takeover_payload',
      question: 'Continue after takeover?',
      recipientHandle: 'term_legacy_coord'
    })
    const run = db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })!
    const answered = db!.answerQuestion({
      messageId: ask.question.message_id,
      runId: state.adoptedRunId,
      consumerGeneration: run.consumer_generation,
      body: 'continue'
    })
    expect(answered.message).toMatchObject({
      from_handle: `run:${state.adoptedRunId}`,
      to_handle: `dispatch:${state.fixture.legacyDispatchId}`,
      delivery_contract: 'current_delivery'
    })

    const acknowledged = db!.acknowledgeLegacyQuestionAnswer({
      principalId: state.workerPrincipalId,
      questionId: ask.question.message_id,
      answerMessageId: answered.message.id
    })

    expect(acknowledged.duplicate).toBe(false)
    expect(db!.getMessageById(answered.message.id)?.read).toBe(1)
    expect(
      db!.acknowledgeLegacyQuestionAnswer({
        principalId: state.workerPrincipalId,
        questionId: ask.question.message_id,
        answerMessageId: answered.message.id
      }).duplicate
    ).toBe(true)
  })
})
