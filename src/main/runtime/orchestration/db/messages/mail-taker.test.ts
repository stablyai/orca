import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { getQuestionTaker } from './mail-taker'

describe('who took an agent question', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function admit(purpose: 'question' | 'status', root: string): string {
    const admitted = db.admitBotRequest({
      rootKey: root,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose,
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:asker', to: 'term_docs', subject: root, type: purpose }
    })
    return admitted.kind === 'sent' ? admitted.message.id : ''
  }

  it('records the reader of a question at its read, and a later read never moves it', () => {
    const question = admit('question', 'q')
    const status = admit('status', 's')

    db.markAsRead([question, status], { kind: 'terminal', handle: 'term_docs' })
    db.markAsRead([question], { kind: 'reply' })

    expect(getQuestionTaker(db, question)).toBe('terminal:term_docs')
    expect(getQuestionTaker(db, status)).toBeNull()
  })

  it('records a drop as a take by nobody', () => {
    const question = admit('question', 'q')
    db.markAsReadAndDelivered([question], { kind: 'dropped', why: 'withdrawn' })
    expect(getQuestionTaker(db, question)).toBe('dropped:withdrawn')
  })

  it('clears what an asker may still be owed once any outcome is written', () => {
    const unanswered = admit('question', 'a')
    const answered = admit('question', 'b')
    db.db.prepare('UPDATE bot_requests SET awaiting = 1').run()

    db.recordBotRequestOutcome(unanswered, 'unanswered')
    db.recordBotAnswer(answered)

    const awaiting = db.db
      .prepare('SELECT COUNT(*) AS n FROM bot_requests WHERE awaiting = 1')
      .get()
    expect(awaiting).toEqual({ n: 0 })
  })
})
