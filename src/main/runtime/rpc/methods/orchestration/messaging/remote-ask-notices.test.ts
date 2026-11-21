import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { openRemoteRunLink } from '../../../../orchestration/db/remote-owned/remote-run-links'
import {
  getRemoteOwnedQuestion,
  recordRemoteAskAnswered
} from '../../../../orchestration/db/remote-owned/remote-dispatch-records'
import { noteQuestionEdge } from '../../../../orchestration/db/messages/question-edges'
import { startRestingQuestionReconciler } from '../../../../orchestration/mailbox/questions/question-reconciler.test-fixture'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { remoteAskNotices } from './remote-ask-notices'

const call = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../../../../orchestration/federation/remote-owned/remote-owned-calls', () => ({
  callRemoteOwnedServer: (...args: unknown[]) => call.send(...args)
}))

const COORDINATOR = testOrcaSessionId('33333333-3333-4333-8333-333333333333')
const UNREACHABLE = Object.assign(new Error('offline'), { code: 'remote_runtime_unavailable' })

describe("a paired worker's question its coordinator here stopped on", () => {
  let db: OrchestrationDb
  const runtime = {} as unknown as OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime.getOrchestrationDb = () => db
    call.send.mockReset()
  })
  afterEach(() => db.close())

  function askedFromBox(): string {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORDINATOR
    })
    const link = openRemoteRunLink(db, run.id, {
      environmentId: 'env_box',
      name: 'Build Box',
      peerFingerprint: 'fp-host',
      homePeerFingerprint: 'fp-home',
      pairingRevision: 1
    })
    const question = db.insertMessage({
      from: 'term_w',
      to: `run:${run.id}`,
      subject: 'Question',
      type: 'question',
      runId: run.id
    })
    db.db
      .prepare(
        `INSERT INTO remote_owned_questions (message_id, conversation_id, run_id, environment_id, dispatch_id)
         VALUES (?, ?, ?, 'env_box', 'ctx_box')`
      )
      .run(question.id, link.conversation_id, run.id)
    return question.id
  }

  async function decided(reconciler: { settled(): Promise<void> }) {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      await reconciler.settled()
    }
  }

  function start() {
    const questions = startRestingQuestionReconciler(db, async (taker) =>
      remoteAskNotices(runtime, taker)
    )
    onTestFinished(questions.stop)
    return questions.reconciler
  }

  it('sends the notice to the worker there once, with one request id, and records it', async () => {
    call.send.mockResolvedValue({ message: { id: 'msg_there' } })
    const reconciler = start()
    const id = askedFromBox()
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)
    reconciler.decideAll()
    await decided(reconciler)

    expect(call.send).toHaveBeenCalledTimes(1)
    expect(call.send.mock.calls[0]![2]).toMatchObject({
      method: 'orchestration.send',
      params: { to: 'dispatch:ctx_box', threadId: id, type: 'status' },
      requestId: `question-notice:${id}`
    })
    expect(getRemoteOwnedQuestion(db, id)).toMatchObject({ ended: 'unanswered', awaiting: null })
  })

  it('keeps it owed while that computer is unreachable, and sends it on its next pull', async () => {
    call.send.mockRejectedValueOnce(UNREACHABLE).mockResolvedValue({})
    const reconciler = start()
    const id = askedFromBox()
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)
    expect(getRemoteOwnedQuestion(db, id)).toMatchObject({ ended: null, awaiting: 1 })

    noteQuestionEdge({ kind: 'reachable', environmentId: 'env_box' })
    await decided(reconciler)

    expect(call.send).toHaveBeenCalledTimes(2)
    expect(getRemoteOwnedQuestion(db, id)).toMatchObject({ ended: 'unanswered', awaiting: null })
  })

  it('owes nothing once the answer reached that computer', async () => {
    const reconciler = start()
    const id = askedFromBox()
    recordRemoteAskAnswered(db, id)
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)

    expect(call.send).not.toHaveBeenCalled()
    expect(getRemoteOwnedQuestion(db, id)?.ended).toBe('answered')
  })
})
