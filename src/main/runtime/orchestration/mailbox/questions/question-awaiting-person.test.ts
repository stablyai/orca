import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { reconcileQuestions } from './question-reconcile'
import { readQuestionPartyFacts, type QuestionPartyReads } from './question-party-facts'

// A question a chat taker holds, while a person is being asked: its turn stopped on a card the
// human has not answered, so the answer it owes is still coming — telling the asker otherwise is
// what #50239 measured (283 notices between 2026-11-24 and 11-26).
const SESSION = 'orca_session_id:askee'
const TAKER = `session:${SESSION}`

describe('a chat taker waiting on a person', () => {
  let db: OrchestrationDb
  let awaitingPerson: boolean

  const reads: QuestionPartyReads = {
    liveSession: (root) => root,
    chatRunning: async () => false,
    chatAwaitingPerson: async () => awaitingPerson,
    chatReceiving: () => null,
    chatHandingOver: () => false,
    terminal: () => null,
    terminalHandingOver: () => false
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    awaitingPerson = false
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
      message: { from: 'orca_session_id:asker', to: SESSION, subject: 'q', type: 'question' }
    })
    const id = admitted.kind === 'sent' ? admitted.message.id : ''
    db.markAsRead([id], { kind: 'session', sessionId: SESSION })
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

  it('holds the question while its turn waits on a person', async () => {
    const id = takenQuestion()
    awaitingPerson = true
    expect(await told()).toEqual([])
    // Still awaiting, so the answer can still land and settle it.
    expect(db.db.prepare(`SELECT awaiting FROM bot_requests WHERE message_id = ?`).get(id)).toEqual(
      {
        awaiting: 1
      }
    )
  })

  it('tells the asker once that person has answered and no reply came', async () => {
    const id = takenQuestion()
    awaitingPerson = true
    expect(await told()).toEqual([])
    awaitingPerson = false
    expect(await told()).toEqual([id])
  })
})
