import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration/db'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

const COORDINATOR_HANDLE = 'term_legacy_coord'
const CURRENT_COORDINATOR_HANDLE = 'term_current_coord'
const CURRENT_COORDINATOR_PANE = 'tab_current:55555555-5555-4555-8555-555555555555'
const WORKER_HANDLE = 'term_legacy_worker'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function createHarness(options?: { seedCutoverQuestion?: boolean; seedCutoverAnswer?: boolean }): {
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  adoptedRunId: string
  dispatchId: string
  cutoverQuestionId?: string
  cutoverAnswerId?: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-question-takeover-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    spec: 'legacy assignment',
    createdByTerminalHandle: COORDINATOR_HANDLE
  })
  const dispatch = createRootDispatch(before, task.id, WORKER_HANDLE, WORKER_PANE)
  const cutoverQuestion = options?.seedCutoverQuestion
    ? before.insertMessage({
        from: WORKER_HANDLE,
        to: COORDINATOR_HANDLE,
        subject: 'Question',
        body: 'Continue after update?',
        type: 'decision_gate',
        payload: JSON.stringify({
          question: 'Continue after update?',
          options: ['yes', 'no']
        })
      })
    : undefined
  const cutoverAnswer =
    cutoverQuestion && options?.seedCutoverAnswer
      ? before.insertMessage({
          from: COORDINATOR_HANDLE,
          to: WORKER_HANDLE,
          subject: 'Re: Question',
          body: 'Continue.',
          threadId: cutoverQuestion.id
        })
      : undefined
  before.close()

  const raw = new Database(dbPath)
  raw.exec(`
    UPDATE dispatch_contexts SET process_incarnation = 'process-1';
    DROP INDEX IF EXISTS idx_messages_delivery_contract;
    DROP TABLE legacy_mail_receipts;
    DROP TABLE legacy_operation_receipts;
    DROP TABLE legacy_compatibility_principals;
    DROP TABLE legacy_adoptions;
  `)
  raw.pragma('user_version = 18')
  raw.close()

  const db = new OrchestrationDb(dbPath)
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === WORKER_HANDLE
      ? WORKER_PANE
      : handle === CURRENT_COORDINATOR_HANDLE
        ? CURRENT_COORDINATOR_PANE
        : null
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
    const worker =
      evidence?.terminalHandle === WORKER_HANDLE &&
      evidence.paneKey === WORKER_PANE &&
      evidence.launchToken === 'worker-token'
    const coordinator =
      evidence?.terminalHandle === CURRENT_COORDINATOR_HANDLE &&
      evidence.paneKey === CURRENT_COORDINATOR_PANE &&
      evidence.launchToken === 'current-coordinator-token'
    const launchToken = worker
      ? 'worker-token'
      : coordinator
        ? 'current-coordinator-token'
        : undefined
    return launchToken
      ? {
          hostScope: { kind: 'local', hostId: 'local' },
          terminalHandle: evidence?.terminalHandle as string,
          paneKey: evidence?.paneKey as string,
          processIncarnation: 'process-1',
          launchTokenHash: createHash('sha256').update(launchToken).digest('hex')
        }
      : null
  })
  return {
    db,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    adoptedRunId: db.getLegacyAdoption()?.adopted_run_id as string,
    dispatchId: dispatch.id,
    ...(cutoverQuestion ? { cutoverQuestionId: cutoverQuestion.id } : {}),
    ...(cutoverAnswer ? { cutoverAnswerId: cutoverAnswer.id } : {})
  }
}

function request(
  method: string,
  params: unknown,
  invocationId: string,
  evidence?: OrchestrationCompatibilityEvidence
): RpcRequest {
  return {
    id: `rpc_${invocationId}`,
    authToken: 'caller-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: invocationId,
    compatibilityInvocationId: invocationId,
    orchestrationCompatibilityEvidence: evidence
  }
}

const workerEvidence: OrchestrationCompatibilityEvidence = {
  terminalHandle: WORKER_HANDLE,
  paneKey: WORKER_PANE,
  launchToken: 'worker-token'
}

describe('legacy question takeover compatibility', () => {
  it('reuses a pending ask that crossed the schema cutover', async () => {
    const harness = createHarness({ seedCutoverQuestion: true })

    const asked = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        {
          from: WORKER_HANDLE,
          to: COORDINATOR_HANDLE,
          question: 'Continue after update?',
          options: 'yes,no',
          timeoutMs: 0
        },
        'retry-cutover-ask',
        workerEvidence
      )
    )

    expect(asked).toMatchObject({
      ok: true,
      result: {
        messageId: harness.cutoverQuestionId,
        legacyCompatibility: { replayed: true }
      }
    })
    const sqlite = (harness.db as unknown as { db: Database.Database }).db
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count
             FROM messages
             WHERE type IN ('decision_gate', 'question')`
          )
          .get() as { count: number }
      ).count
    ).toBe(1)
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM question_threads').get() as { count: number })
        .count
    ).toBe(1)
  })

  it('resumes an answered pinned-A ask without duplicating it', async () => {
    const harness = createHarness({
      seedCutoverQuestion: true,
      seedCutoverAnswer: true
    })

    const resumed = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        {
          from: WORKER_HANDLE,
          resume: harness.cutoverQuestionId,
          timeoutMs: 0
        },
        'resume-answered-cutover-ask',
        workerEvidence
      )
    )

    expect(resumed).toMatchObject({
      ok: true,
      result: {
        answer: 'Continue.',
        answerMessageId: harness.cutoverAnswerId,
        messageId: harness.cutoverQuestionId,
        legacyCompatibility: {
          answerAcknowledgement: {
            questionId: harness.cutoverQuestionId,
            answerMessageId: harness.cutoverAnswerId
          }
        }
      }
    })
    const sqlite = (harness.db as unknown as { db: Database.Database }).db
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM question_threads').get() as { count: number })
        .count
    ).toBe(1)
  })

  it('resumes and idempotently acknowledges the exact current Run answer', async () => {
    const harness = createHarness()
    const asked = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        {
          from: WORKER_HANDLE,
          to: COORDINATOR_HANDLE,
          question: 'Continue after takeover?',
          timeoutMs: 0
        },
        'ask-before-takeover',
        workerEvidence
      )
    )
    const questionId = (asked as { result: { messageId: string } }).result.messageId

    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.runUse',
          {
            id: harness.adoptedRunId,
            from: CURRENT_COORDINATOR_HANDLE,
            takeoverLegacy: true
          },
          'take-over',
          {
            terminalHandle: CURRENT_COORDINATOR_HANDLE,
            paneKey: CURRENT_COORDINATOR_PANE,
            launchToken: 'current-coordinator-token'
          }
        )
      )
    ).resolves.toMatchObject({ ok: true })
    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.reply',
          {
            id: questionId,
            body: 'Continue.',
            from: CURRENT_COORDINATOR_HANDLE,
            run: harness.adoptedRunId
          },
          'answer-after-takeover'
        )
      )
    ).resolves.toMatchObject({ ok: true })

    const resumed = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        { from: WORKER_HANDLE, resume: questionId, timeoutMs: 100 },
        'resume-after-takeover',
        workerEvidence
      )
    )
    expect(resumed).toMatchObject({
      ok: true,
      result: {
        answer: 'Continue.',
        legacyCompatibility: {
          answerAcknowledgement: {
            questionId,
            answerMessageId: expect.any(String)
          }
        }
      }
    })
    const acknowledgement = (
      resumed as {
        result: {
          legacyCompatibility: {
            answerAcknowledgement: { questionId: string; answerMessageId: string }
          }
        }
      }
    ).result.legacyCompatibility.answerAcknowledgement
    expect(harness.db.getMessageById(acknowledgement.answerMessageId)).toMatchObject({
      run_id: harness.adoptedRunId,
      from_handle: `run:${harness.adoptedRunId}`,
      to_handle: `dispatch:${harness.dispatchId}`,
      delivery_contract: 'current_delivery',
      thread_id: questionId
    })

    const acknowledge = (invocationId: string) =>
      harness.dispatcher.dispatch(
        request(
          'orchestration.check',
          {
            terminal: WORKER_HANDLE,
            compatibilityQuestionAck: JSON.stringify(acknowledgement)
          },
          invocationId,
          workerEvidence
        )
      )
    const sqlite = (harness.db as unknown as { db: Database.Database }).db
    sqlite
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run('dispatch:foreign', acknowledgement.answerMessageId)
    await expect(acknowledge('ack-wrong-answer-route')).resolves.toMatchObject({
      ok: false,
      error: { code: 'request_mismatch' }
    })
    sqlite
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(`dispatch:${harness.dispatchId}`, acknowledgement.answerMessageId)

    await expect(acknowledge('ack-answer')).resolves.toMatchObject({
      ok: true,
      result: {
        acknowledged: [acknowledgement.answerMessageId],
        duplicate: false,
        legacyCompatibility: { acknowledged: true }
      }
    })
    await expect(acknowledge('ack-answer-repeat')).resolves.toMatchObject({
      ok: true,
      result: {
        acknowledged: [acknowledgement.answerMessageId],
        duplicate: true,
        legacyCompatibility: { acknowledged: true }
      }
    })
  })
})
