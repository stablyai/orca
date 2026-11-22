import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { reconcileQuestions } from './question-reconcile'
import { readQuestionPartyFacts, type QuestionPartyReads } from './question-party-facts'

const HANDLE = 'term_coordinator'
const TAKER = `terminal:${HANDLE}`

describe("a terminal taker's pending wake", () => {
  let db: OrchestrationDb
  let takesInput: boolean

  let paneKeys: string[]
  const reads: QuestionPartyReads = {
    liveSession: (root) => root,
    chatRunning: async () => false,
    chatReceiving: () => null,
    chatHandingOver: () => false,
    terminal: (handle) =>
      handle === HANDLE
        ? { ptyId: 'pty-1', paneKeys, asking: false, takesInput, working: false }
        : null,
    terminalHandingOver: () => false
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    takesInput = true
    paneKeys = []
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

  it("doesn't count a Run's mail left in its old coordinator's mailbox, which routing moves elsewhere", async () => {
    const id = takenQuestion()
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: null
    })
    // Stored before this terminal became the Run's alias, so it still sits in its own mailbox.
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'r', body: 'b', runId: run.id })
    db.rememberRunCoordinatorHandle(run.id, HANDLE)
    expect(await told()).toEqual([id])
  })

  it('holds the question for a Run it coordinates, whose rows in its own mailbox are routed to it and typed', async () => {
    takenQuestion()
    paneKeys = ['tab-1:11111111-1111-4111-8111-111111111111']
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: HANDLE,
      coordinatorPaneKey: paneKeys[0],
      coordinatorOrcaSessionId: null
    })
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'r', body: 'b' })
    db.db.prepare('UPDATE messages SET run_id = ? WHERE subject = ?').run(run.id, 'r')
    expect(await told()).toEqual([])
  })

  it("doesn't count another Run's rows in a coordinator's own mailbox, which go to that Run's owner", async () => {
    const id = takenQuestion()
    paneKeys = ['tab-1:11111111-1111-4111-8111-111111111111']
    db.createRun({
      objective: 'bound',
      coordinatorHandle: HANDLE,
      coordinatorPaneKey: paneKeys[0],
      coordinatorOrcaSessionId: null
    })
    const other = db.createRun({
      objective: 'other',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: null
    })
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'r', body: 'b', runId: other.id })
    db.rememberRunCoordinatorHandle(other.id, HANDLE)
    expect(await told()).toEqual([id])
  })
})
