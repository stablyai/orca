import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { getQuestionTaker } from '../../db/messages/mail-taker'
import { settleStructuredMailAttempt } from './structured-mail-custody'
import type { JournalMailObservation } from '../../../../native-chat/agent-session-journal/journal-mail-observation'
import type { QueuedMessageOwed } from '../../../../native-chat/agent-session-journal/queued-messages/queued-message-consume-error'

describe('who took a question a chat was sent', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function settle(
    id: string,
    state: JournalMailObservation['state'],
    owed: QueuedMessageOwed,
    withdrawal: JournalMailObservation['withdrawal'] = 'unknown'
  ) {
    db.admitBotRequest({
      rootKey: id,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { id, from: 'orca_session_id:asker', to: 'term_docs', subject: id, type: 'question' }
    })
    const attempt = {
      mailbox_handle: 'term_docs',
      message_id: id,
      session_id: 'session-docs',
      operation_id: `op-${id}`,
      minted_at_ms: 100
    }
    expect(db.reserveStructuredMailSend(attempt)).toBe(true)
    // No body: the observation cannot show the card went in whole.
    settleStructuredMailAttempt(
      db,
      attempt,
      { epoch: 'e', state, body: null, withdrawal },
      () => owed
    )
    return { taker: getQuestionTaker(db, id), read: db.getMessageById(id)?.read }
  }

  it('hands a card the chat accepted, but not whole, to that chat and leaves it unread', () => {
    expect(settle('msg_a', { kind: 'accepted' }, 'owed')).toEqual({
      taker: 'session:session-docs',
      read: 0
    })
    expect(settle('msg_u', { kind: 'unknown' }, 'owed')).toEqual({
      taker: 'session:session-docs',
      read: 0
    })
  })

  it('takes nothing for mail that goes to another owner', () => {
    expect(settle('msg_s', { kind: 'unknown' }, 'stale')).toEqual({ taker: null, read: 0 })
  })

  it('records a card its person removed before the agent read it as dropped', () => {
    expect(settle('msg_w', { kind: 'withdrawn' }, 'owed', 'person')).toEqual({
      taker: 'dropped:withdrawn',
      read: 1
    })
  })
})
