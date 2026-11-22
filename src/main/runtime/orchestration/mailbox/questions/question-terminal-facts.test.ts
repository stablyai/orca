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

  const reads: Omit<QuestionPartyReads, 'chatRunning'> & Pick<QuestionPartyReads, 'chatRunning'> = {
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
})
