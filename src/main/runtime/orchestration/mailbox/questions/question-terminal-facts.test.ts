import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { reconcileQuestions } from './question-reconcile'
import { readQuestionPartyFacts, type QuestionPartyReads } from './question-party-facts'
import { QuestionReconciler } from './question-reconciler'
import { noteQuestionEdge } from '../../db/messages/question-edges'

const HANDLE = 'term_coordinator'
const TAKER = `terminal:${HANDLE}`

describe("a terminal taker's pending wake", () => {
  let db: OrchestrationDb
  let takesInput: boolean

  const reads: QuestionPartyReads = {
    liveSession: (root) => root,
    chatRunning: async () => false,
    chatReceiving: () => null,
    chatHandingOver: () => false,
    terminal: (handle) =>
      handle === HANDLE
        ? { ptyId: 'pty-1', paneKeys: [], asking: false, takesInput, working: false }
        : null,
    terminalHandingOver: () => false
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    takesInput = true
  })
  afterEach(() => db.close())

  function takenQuestion(): string {
    const admitted = db.admitBotRequest({
      rootKey: 'a',
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:asker', to: HANDLE, subject: 'q', type: 'question' }
    })
    const id = admitted.kind === 'sent' ? admitted.message.id : ''
    db.markAsRead([id], { kind: 'terminal', handle: HANDLE })
    return id
  }

  async function told(): Promise<string[]> {
    const facts = await readQuestionPartyFacts(db, reads, [TAKER])
    return reconcileQuestions(
      db,
      facts,
      (notice) => {
        db.recordBotRequestOutcome(notice.messageId, 'unanswered')
        return 'told'
      },
      TAKER
    ).map((notice) => notice.messageId)
  }

  it('holds the question while mail waits to be typed into the agent', async () => {
    takenQuestion()
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'status', body: 'b' })
    expect(await told()).toEqual([])
  })

  it('tells the asker when the agent exited to its shell, since that mail is never typed', async () => {
    const id = takenQuestion()
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'status', body: 'b' })
    takesInput = false
    expect(await told()).toEqual([id])
  })
})

describe('a terminal coordinator with no agent in it (#49550)', () => {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
  let db: OrchestrationDb
  let live: boolean
  let working: boolean
  let told: string[]
  let reconciler: QuestionReconciler
  let stop: () => void

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    live = true
    working = false
    told = []
    db.createRun({
      objective: 'o',
      coordinatorHandle: HANDLE,
      coordinatorPaneKey: PANE,
      coordinatorOrcaSessionId: null
    })
    reconciler = new QuestionReconciler(db, {
      reads: {
        liveSession: (root) => root,
        chatRunning: async () => false,
        chatReceiving: () => null,
        chatHandingOver: () => false,
        terminal: (handle) =>
          handle === HANDLE && live
            ? { ptyId: 'pty-1', paneKeys: [PANE], asking: false, takesInput: false, working }
            : null,
        terminalHandingOver: () => false
      },
      notices: async () => (notice) => {
        db.recordBotRequestOutcome(notice.messageId, 'unanswered')
        told.push(notice.messageId)
        return 'told'
      },
      sessionParty: (sessionId) => `session:${sessionId}`,
      terminalParty: () => TAKER
    })
    stop = reconciler.start()
  })
  afterEach(() => {
    stop()
    db.close()
  })

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await reconciler.settled()
  }

  async function take(): Promise<string> {
    const admitted = db.admitBotRequest({
      rootKey: 'a',
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:asker', to: HANDLE, subject: 'q', type: 'question' }
    })
    const id = admitted.kind === 'sent' ? admitted.message.id : ''
    db.markAsRead([id], { kind: 'terminal', handle: HANDLE })
    await settle()
    return id
  }

  it('holds a question it read while its terminal lives, and tells once the terminal exits', async () => {
    const id = await take()
    expect(told).toEqual([])
    live = false
    noteQuestionEdge({ kind: 'exit', handle: HANDLE })
    await settle()
    expect(told).toEqual([id])
  })

  it('still tells when an agent coordinator stops at its shell', async () => {
    working = true
    const id = await take()
    expect(told).toEqual([])
    working = false
    reconciler.terminalChanged(TAKER, false)
    await settle()
    expect(told).toEqual([id])
  })
})
