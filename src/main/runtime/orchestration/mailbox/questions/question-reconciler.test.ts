import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { noteQuestionEdge } from '../../db/messages/question-edges'
import type { MailTaker } from '../../db/messages/mail-taker'
import { QuestionReconciler } from './question-reconciler'
import type { QuestionPartyReads } from './question-party-facts'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'

const BOT = '22222222-2222-4222-8222-222222222222'
const MAILBOX = `orca_session_id:${BOT}`
const TAKER: MailTaker = { kind: 'session', sessionId: BOT }

describe('telling an agent question asker its taker stopped', () => {
  let db: OrchestrationDb
  let told: string[]
  let running: boolean
  let handingOver: boolean
  let stop: () => void
  let reconciler: QuestionReconciler

  const reads: QuestionPartyReads = {
    liveSession: (root) => root,
    chatRunning: async () => running,
    chatReceiving: (mailbox) => (mailbox === MAILBOX ? BOT : null),
    chatHandingOver: () => handingOver,
    terminal: () => null,
    terminalHandingOver: () => false
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    told = []
    running = false
    handingOver = false
    reads.chatRunning = async () => running
    reads.chatReceiving = (mailbox) => (mailbox === MAILBOX ? BOT : null)
    reconciler = new QuestionReconciler(db, {
      reads,
      notices: async () => (notice) => {
        db.recordBotRequestOutcome(notice.messageId, 'unanswered')
        told.push(notice.messageId)
        return 'told'
      },
      sessionParty: (sessionId) => `session:${sessionId}`,
      terminalParty: () => null
    })
    stop = reconciler.start()
  })
  afterEach(() => {
    stop()
    db.close()
  })

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      await reconciler.settled()
    }
  }

  function ask(root: string): string {
    const admitted = db.admitBotRequest({
      rootKey: root,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:asker', to: MAILBOX, subject: 'q', type: 'question' }
    })
    return admitted.kind === 'sent' ? admitted.message.id : ''
  }

  it('tells once when the taker is at rest with nothing coming', async () => {
    const id = ask('a')
    db.markAsRead([id], TAKER)
    await settle()
    reconciler.chatObserved(BOT, false)
    await settle()
    expect(told).toEqual([id])
  })

  it('waits while the taker runs, and tells when its turn ends', async () => {
    running = true
    const id = ask('a')
    db.markAsRead([id], TAKER)
    await settle()
    expect(told).toEqual([])
    running = false
    reconciler.chatObserved(BOT, false)
    await settle()
    expect(told).toEqual([id])
  })

  it('waits on mail that would wake the taker, and tells once another reader takes it', async () => {
    const first = ask('a')
    db.markAsRead([first], TAKER)
    const second = ask('b')
    await settle()
    expect(told).toEqual([])
    // A shell `check` reads the mail that held it: nothing will wake the taker now.
    db.markAsRead([second], { kind: 'shell' })
    await settle()
    expect(told.sort()).toEqual([first, second].sort())
  })

  it('waits while a delivery pass hands mail over, and a send row that never retires holds nothing', async () => {
    const id = ask('a')
    db.markAsRead([id], TAKER)
    const status = db.insertMessage({ from: 'orca_session_id:asker', to: MAILBOX, subject: 'fyi' })
    handingOver = true
    db.reserveStructuredMailSend({
      mailbox_handle: MAILBOX,
      message_id: status.id,
      session_id: BOT,
      operation_id: 'op-1',
      minted_at_ms: Date.now()
    })
    await settle()
    expect(told).toEqual([])
    // The pass ended without the chat taking the card: its row stays, unretired.
    handingOver = false
    noteQuestionEdge({ kind: 'mailbox', mailbox: MAILBOX })
    await settle()
    expect(db.getStructuredMailSend(MAILBOX, status.id)).toBeDefined()
    expect(told).toEqual([id])
  })

  it('waits while a worker started --for the question is starting, and tells when its start fails', async () => {
    const id = ask('a')
    db.markAsRead([id], TAKER)
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'tab_c:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'answer', runId: run.id })
    const worker = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      forMessageId: id
    })
    reconciler.chatObserved(BOT, false)
    await settle()
    expect(told).toEqual([])
    db.failDispatch(worker.dispatch.id, 'start failed', { workerProcessExited: true })
    await settle()
    expect(told).toEqual([id])
  })

  it('decides again after an edge that lands while it reads, so a stale read never holds', async () => {
    const id = ask('a')
    let release: () => void = () => undefined
    running = true
    reads.chatRunning = () =>
      new Promise((resolve) => {
        release = () => resolve(running)
      })
    db.markAsRead([id], TAKER)
    await new Promise((resolve) => setImmediate(resolve))
    // Mid-read, the turn ends; that observation comes before the read returns "running".
    running = false
    reconciler.chatObserved(BOT, false)
    running = true
    release()
    reads.chatRunning = async () => false
    await settle()
    expect(told).toEqual([id])
  })

  it('tells nothing on a stopped read when the taker starts running while it reads', async () => {
    const id = ask('a')
    let release: () => void = () => undefined
    reads.chatRunning = () =>
      new Promise((resolve) => {
        release = () => resolve(false)
      })
    db.markAsRead([id], TAKER)
    await new Promise((resolve) => setImmediate(resolve))
    // A delivery starts its turn mid-read: the read still answers "stopped".
    reconciler.chatObserved(BOT, true)
    release()
    await settle()
    expect(told).toEqual([])
    reads.chatRunning = async () => false
    reconciler.chatObserved(BOT, false)
    await settle()
    expect(told).toEqual([id])
  })

  it('tells the coordinator a Run held once that Run is unbound from it', async () => {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: testOrcaSessionId(BOT)
    })
    let bound = true
    reads.chatReceiving = (mailbox) =>
      mailbox === MAILBOX || (bound && mailbox === `run:${run.id}`) ? BOT : null
    const id = ask('a')
    db.markAsRead([id], TAKER)
    // A report waits in the Run's mail: it would wake the coordinator.
    db.insertMessage({ from: 'term_w', to: `run:${run.id}`, subject: 'done', runId: run.id })
    await settle()
    expect(told).toEqual([])
    bound = false
    db.unbindOtherRunsForCoordinator(
      { terminalHandle: null, paneKey: null, orcaSessionId: testOrcaSessionId(BOT) },
      'run_other'
    )
    await settle()
    expect(told).toEqual([id])
  })
})
