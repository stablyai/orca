import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { stampQuestionTakes } from '../../../../orchestration/db/messages/mail-taker'
import { dropReaderlessRunQuestions } from '../../../../orchestration/db/questions/readerless-run-questions'
import { startRestingQuestionReconciler } from '../../../../orchestration/mailbox/questions/question-reconciler.test-fixture'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { workerAskNotices } from './worker-ask-notices'

// #50721: a request whose outcome is recorded is never handed over again as new mail, though its
// handover (a pointer) left it unread; a worker ask no one can read stays unread for a later coordinator.

const COORDINATOR = testOrcaSessionId('44444444-4444-4444-8444-444444444444')

let directory = ''
let db: OrchestrationDb

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-settled-request-mail-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function workerAsk(coordinatorOrcaSessionId: typeof COORDINATOR | null): {
  runId: string
  id: string
} {
  const runId = db.createRun({
    objective: 'o',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId
  }).id
  const task = db.createTask({ spec: 'w', runId })
  const dispatchId = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  }).dispatch.id
  db.markWorkerDispatchReady(dispatchId)
  const { message } = db.createQuestion({
    runId,
    dispatchId,
    askerHandle: 'term_w',
    question: 'Red or blue?'
  })
  return { runId, id: message.id }
}

const unread = (mailbox: string) => db.getUnreadMessages(mailbox).map((m) => m.id)

describe("a worker's ask its coordinator stopped on", () => {
  function startReconciler() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notice writer reads only these members.
    const runtime = {
      getOrchestrationDb: () => db,
      notifyMessageArrived: vi.fn(),
      notifyMessageWaiters: vi.fn(),
      ensureOrchestrationFederationRelay: vi.fn()
    } as unknown as OrcaRuntimeService
    const { reconciler, stop } = startRestingQuestionReconciler(db, async (taker) =>
      workerAskNotices(runtime, taker)
    )
    onTestFinished(stop)
    return reconciler
  }

  async function decided(reconciler: { settled(): Promise<void> }) {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      await reconciler.settled()
    }
  }

  it('is read once told unanswered, though its pointer handover left it unread', async () => {
    const reconciler = startReconciler()
    const { runId, id } = workerAsk(COORDINATOR)
    stampQuestionTakes(db, [id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)

    expect(db.getQuestionRaw(id)?.told).toBe('unanswered')
    expect(unread(`run:${runId}`)).not.toContain(id)
  })

  it('stays unread when no one coordinates its Run, so a later coordinator can answer it', async () => {
    const reconciler = startReconciler()
    const { runId, id } = workerAsk(null)
    dropReaderlessRunQuestions(db, runId)
    await decided(reconciler)

    expect(db.getQuestionRaw(id)?.told).toBe('dropped')
    expect(unread(`run:${runId}`)).toContain(id)
  })
})

it('reads requests settled unread before this build, and leaves a dropped worker ask unread', () => {
  const told = workerAsk(COORDINATOR)
  const noReader = workerAsk(null)
  const admitted = db.admitBotRequest({
    rootKey: 'q',
    fromBotId: 'asker',
    toBotId: 'taker',
    purpose: 'handoff',
    depth: 1,
    record: '{}',
    message: { from: 'term_asker', to: 'term_taker', subject: 'H', type: 'handoff' }
  })
  if (admitted.kind !== 'sent') {
    throw new Error(admitted.kind)
  }
  const handoff = admitted.message.id
  // As a build before the rule left them: outcomes recorded, mail unread.
  db.db
    .prepare("INSERT INTO bot_request_outcomes (message_id, outcome) VALUES (?, 'unanswered')")
    .run(handoff)
  db.db.prepare("UPDATE question_threads SET told = 'unanswered' WHERE message_id = ?").run(told.id)
  db.db
    .prepare("UPDATE question_threads SET told = 'dropped' WHERE message_id = ?")
    .run(noReader.id)
  const closed = workerAsk(COORDINATOR)
  db.db.prepare("UPDATE question_threads SET status = 'closed' WHERE message_id = ?").run(closed.id)
  // A paired worker's ask, answered there.
  const remote = db.insertMessage({
    from: 'term_w',
    to: `run:${told.runId}`,
    subject: 'Question',
    type: 'question',
    runId: told.runId
  }).id
  db.db
    .prepare(
      `INSERT INTO remote_owned_questions (message_id, conversation_id, run_id, environment_id, dispatch_id, ended)
       VALUES (?, 'conv', ?, 'env_box', 'ctx_box', 'answered')`
    )
    .run(remote, told.runId)
  db.db.pragma('user_version = 52')
  db.close()

  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  expect(unread('term_taker')).not.toContain(handoff)
  expect(unread(`run:${told.runId}`)).not.toContain(told.id)
  expect(unread(`run:${closed.runId}`)).not.toContain(closed.id)
  expect(unread(`run:${told.runId}`)).not.toContain(remote)
  expect(unread(`run:${noReader.runId}`)).toContain(noReader.id)
})
