import { afterEach, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const harness = createOrchestrationRpcHarness()
afterEach(() => harness.cleanup())

it('acknowledges only selected recipient IDs, atomically rejects mixed recipients, and tolerates retries', async () => {
  const { db, ctx } = harness.setup(false)
  const check = (params: Record<string, unknown>) =>
    harness.call(
      params.ackIds ? 'orchestration.ackMessages' : 'orchestration.check',
      { terminal: 'term_coord', ...params },
      ctx
    )
  db.insertMessage({ id: 'msg_stale', from: 'sender', to: 'term_coord', subject: 'old status' })
  await check({ peek: true })
  db.insertMessage({
    id: 'msg_question',
    from: 'sender',
    to: 'term_coord',
    subject: 'new question',
    type: 'question'
  })
  db.insertMessage({ id: 'msg_foreign', from: 'sender', to: 'term_other', subject: 'other inbox' })

  await expect(check({ ackIds: ['msg_stale', 'msg_foreign'] })).rejects.toMatchObject({
    code: 'invalid_argument',
    data: { effectsApplied: false }
  })
  await expect(check({ ackIds: ['msg_stale', 'msg_missing'] })).rejects.toMatchObject({
    code: 'invalid_argument',
    data: { effectsApplied: false }
  })
  expect(db.getUnreadMessages('term_coord').map((message) => message.id)).toEqual([
    'msg_stale',
    'msg_question'
  ])
  await expect(check({ ackIds: ['msg_stale', 'msg_stale'] })).resolves.toMatchObject({
    markedIds: ['msg_stale'],
    alreadyReadIds: []
  })
  await expect(check({ ackIds: ['msg_stale'] })).resolves.toMatchObject({
    markedIds: [],
    alreadyReadIds: ['msg_stale']
  })
  expect(db.getUnreadMessages('term_coord').map((message) => message.id)).toEqual(['msg_question'])
  expect(db.getUnreadMessages('term_other').map((message) => message.id)).toEqual(['msg_foreign'])
})
