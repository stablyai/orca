import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { BOT_REQUEST_OUTCOME_METHOD } from './bots-request-outcome'

describe('bots.request.outcome', () => {
  let db: OrchestrationDb
  afterEach(() => db.close())

  const read = (messageId: string, pairedDeviceId?: string, callerScope?: { kind: string }) => {
    const context = { runtime: { getOrchestrationDb: () => db }, pairedDeviceId, callerScope }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these three context fields.
    return BOT_REQUEST_OUTCOME_METHOD.handler({ messageId }, context as never)
  }

  it('reads how a request ended and the answer the card shows', () => {
    db = new OrchestrationDb(':memory:')
    const sent = db.admitBotRequest({
      rootKey: 'root',
      fromBotId: 'triage',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: {
        from: 'orca_session_id:t',
        to: 'orca_session_id:11111111-1111-4111-8111-111111111111',
        subject: 'Old flag?'
      }
    })
    const id = sent.kind === 'sent' ? sent.message.id : ''
    const chatId = '11111111-1111-4111-8111-111111111111'
    expect(read(id)).toEqual({ outcome: null, answer: null, mailIds: [], chatId })
    const reply = db.insertMessage({
      from: 'orca_session_id:d',
      to: 'orca_session_id:t',
      subject: 'Re: Old flag?',
      body: 'Yes, twice.',
      threadId: id,
      payload: JSON.stringify({ requestId: id, botAnswer: { next: 'Finish the job.' } })
    })
    db.recordBotAnswer(id)
    expect(read(id)).toEqual({
      outcome: 'answered',
      answer: 'Yes, twice.',
      mailIds: [reply.id],
      chatId
    })
    expect(read('msg_nope')).toEqual({ outcome: null, answer: null, mailIds: [], chatId: null })
    expect(read(id, 'phone', { kind: 'mobile' }).answer).toBe('Yes, twice.')
    expect(() => read(id, 'laptop', { kind: 'runtime-paired' })).toThrow(
      /computer that runs the bots/
    )
  })

  it('shows each request its own answer when one thread holds two', () => {
    db = new OrchestrationDb(':memory:')
    const ask = (toBotId: string, threadId?: string) => {
      const sent = db.admitBotRequest({
        rootKey: 'root',
        fromBotId: 'triage',
        toBotId,
        purpose: 'question',
        depth: 1,
        record: '{}',
        message: {
          from: 'orca_session_id:t',
          to: `orca_session_id:${toBotId}`,
          subject: 'Q',
          threadId
        }
      })
      return sent.kind === 'sent' ? sent.message.id : ''
    }
    const answer = (requestId: string, threadId: string, body: string) =>
      db.insertMessage({
        from: 'orca_session_id:x',
        to: 'orca_session_id:t',
        subject: 'Re: Q',
        body,
        threadId,
        payload: JSON.stringify({ requestId, botAnswer: { next: 'Finish the job.' } })
      })
    const first = ask('docs')
    const second = ask('sage', first)
    answer(first, first, 'From docs.')
    answer(second, first, 'From sage.')
    // Mail with no request id, or a payload that is not JSON, is never an answer.
    db.insertMessage({
      from: 'x',
      to: 'orca_session_id:t',
      subject: 'Re',
      body: 'Noise',
      threadId: first,
      payload: '{"botAnswer"'
    })
    expect(read(first).answer).toBe('From docs.')
    expect(read(second).answer).toBe('From sage.')
  })
})
