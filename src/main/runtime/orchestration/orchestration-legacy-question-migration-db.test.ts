import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { createLegacyStorageCutoverFixture } from './orchestration-legacy-storage-test-fixture'

describe('OrchestrationDb legacy question migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  function prepareTakenOverSchema19Question(readAndAcknowledge: boolean): {
    dbPath: string
    adoptedRunId: string
    questionId: string
  } {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    db = new OrchestrationDb(created.fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const questionId = readAndAcknowledge ? 'msg_schema19_acknowledged' : 'msg_schema19_unread'
    db.insertMessage({
      id: questionId,
      runId: adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Question',
      body: 'Continue after takeover?',
      type: 'decision_gate',
      threadId: questionId,
      payload: JSON.stringify({
        taskId: created.fixture.legacyTaskId,
        dispatchId: created.fixture.legacyDispatchId
      })
    })
    if (readAndAcknowledge) {
      db.markAsRead([questionId])
    }
    const coordinator = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    }).principal
    if (readAndAcknowledge) {
      const recovery = db.getLegacyMailPage({ principalId: coordinator.id })
      expect(recovery.messages.map((message) => message.id)).toContain(questionId)
      db.acknowledgeLegacyMail({
        principalId: coordinator.id,
        messageIds: recovery.messages.map((message) => message.id)
      })
    }
    db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })
    expect(db.getMessageById(questionId)).toMatchObject(
      readAndAcknowledge
        ? { delivery_contract: 'legacy_direct', read: 1 }
        : { delivery_contract: 'current_delivery', read: 0 }
    )
    db.close()
    db = undefined

    const raw = new Database(created.fixture.dbPath)
    raw.exec('DROP TABLE question_threads')
    raw.pragma('user_version = 19')
    raw.close()
    return { dbPath: created.fixture.dbPath, adoptedRunId, questionId }
  }

  it('backfills a pre-question-thread ask and its accepted answer', () => {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    db = new OrchestrationDb(created.fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    db.close()
    db = undefined

    const raw = new Database(created.fixture.dbPath)
    raw.exec(`
      DROP TABLE question_threads;
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle,
        subject, body, type, thread_id, payload
      ) VALUES (
        'msg_cutover', '${adoptedRunId}', 'legacy_direct',
        'term_legacy_worker', 'term_legacy_coord', 'Question',
        'Continue?', 'decision_gate', 'msg_cutover',
        '{"taskId":"${created.fixture.legacyTaskId}","dispatchId":"${created.fixture.legacyDispatchId}"}'
      );
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle,
        subject, body, thread_id
      ) VALUES
        (
          'msg_cross_run_decoy', 'run_decoy', 'legacy_direct',
          'term_legacy_coord', 'term_legacy_worker',
          'Re: Question', 'cross-run decoy', 'msg_cutover'
        ),
        (
          'msg_self_sent_decoy', '${adoptedRunId}', 'legacy_direct',
          'term_legacy_worker', 'term_legacy_worker',
          'Re: Question', 'self-sent decoy', 'msg_cutover'
        ),
        (
          'msg_cutover_answer', '${adoptedRunId}', 'legacy_direct',
          'term_legacy_coord', 'term_legacy_worker',
          'Re: Question', 'yes', 'msg_cutover'
        );
    `)
    raw.pragma('user_version = 19')
    raw.close()

    db = new OrchestrationDb(created.fixture.dbPath)
    expect(db.getQuestion('msg_cutover')).toMatchObject({
      run_id: adoptedRunId,
      dispatch_id: created.fixture.legacyDispatchId,
      asker_handle: 'term_legacy_worker',
      status: 'answered',
      answer_message_id: 'msg_cutover_answer',
      answer_body: 'yes'
    })
  })

  it('leaves a question pending when only cross-run and self-sent decoys exist', () => {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    db = new OrchestrationDb(created.fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    db.close()
    db = undefined

    const raw = new Database(created.fixture.dbPath)
    raw.exec(`
      DROP TABLE question_threads;
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle,
        subject, body, type, thread_id, payload
      ) VALUES (
        'msg_pending_cutover', '${adoptedRunId}', 'legacy_direct',
        'term_legacy_worker', 'term_legacy_coord', 'Question',
        'Continue?', 'decision_gate', 'msg_pending_cutover',
        '{"taskId":"${created.fixture.legacyTaskId}","dispatchId":"${created.fixture.legacyDispatchId}"}'
      );
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle,
        subject, body, thread_id
      ) VALUES
        (
          'msg_pending_cross_run_decoy', 'run_decoy', 'legacy_direct',
          'term_legacy_coord', 'term_legacy_worker',
          'Re: Question', 'cross-run decoy', 'msg_pending_cutover'
        ),
        (
          'msg_pending_self_sent_decoy', '${adoptedRunId}', 'legacy_direct',
          'term_legacy_worker', 'term_legacy_worker',
          'Re: Question', 'self-sent decoy', 'msg_pending_cutover'
        );
    `)
    raw.pragma('user_version = 19')
    raw.close()

    db = new OrchestrationDb(created.fixture.dbPath)
    expect(db.getQuestion('msg_pending_cutover')).toMatchObject({
      run_id: adoptedRunId,
      dispatch_id: created.fixture.legacyDispatchId,
      asker_handle: 'term_legacy_worker',
      status: 'pending',
      answer_message_id: null,
      answer_body: null
    })
  })

  it('uses task provenance to disambiguate same-handle same-second asks', () => {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    const raw = new Database(created.fixture.dbPath)
    raw.exec(`
      INSERT INTO tasks (
        id, run_id, spec, status, created_by_terminal_handle, created_at
      ) VALUES
        ('task_question_target', '${LEGACY_RUN_ID}', 'target', 'dispatched',
         'term_legacy_coord', '2026-01-01 00:00:00'),
        ('task_question_other', '${LEGACY_RUN_ID}', 'other', 'dispatched',
         'term_legacy_coord', '2026-01-01 00:00:00');
      INSERT INTO dispatch_contexts (
        id, run_id, task_id, contract_version, assignee_handle,
        assignee_pane_key, status, dispatched_at, created_at
      ) VALUES
        ('dispatch_question_target', '${LEGACY_RUN_ID}', 'task_question_target', 0,
         'term_legacy_worker', 'tab_target:11111111-1111-4111-8111-111111111111',
         'dispatched', '2026-01-01 00:00:00', '2026-01-01 00:00:00'),
        ('dispatch_question_other', '${LEGACY_RUN_ID}', 'task_question_other', 0,
         'term_legacy_worker', 'tab_other:22222222-2222-4222-8222-222222222222',
         'dispatched', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle,
        subject, body, type, payload, created_at
      ) VALUES (
        'msg_question_task_only', '${LEGACY_RUN_ID}', 'legacy_direct',
        'term_legacy_worker', 'term_legacy_coord', 'Question', 'Continue?',
        'decision_gate', '{"taskId":"task_question_target","question":"Continue?","options":[]}',
        '2026-01-01 00:00:00'
      );
    `)
    raw.close()

    db = new OrchestrationDb(created.fixture.dbPath)
    expect(db.getQuestion('msg_question_task_only')).toMatchObject({
      dispatch_id: 'dispatch_question_target',
      asker_handle: 'term_legacy_worker',
      status: 'pending'
    })
  })

  it.each([
    ['promoted unread', false],
    ['acknowledged recovery', true]
  ] as const)('backfills and routes a %s v19 question after takeover', (_label, acknowledged) => {
    const state = prepareTakenOverSchema19Question(acknowledged)

    db = new OrchestrationDb(state.dbPath)
    expect(db.getQuestion(state.questionId)).toMatchObject({
      run_id: state.adoptedRunId,
      status: 'pending'
    })
    expect(db.getMessageById(state.questionId)).toMatchObject({
      to_handle: `run:${state.adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })
    const run = db.getRun(state.adoptedRunId)!
    expect(
      db
        .getOrCreateRunDelivery({
          runId: state.adoptedRunId,
          consumerGeneration: run.consumer_generation
        })
        ?.messages.map((message) => message.id)
    ).toContain(state.questionId)
  })
})
