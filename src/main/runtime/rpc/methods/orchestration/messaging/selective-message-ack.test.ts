import { afterEach, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
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

it('selectively acknowledges inspected pre-bind Dispatch mail through its current child Run consumer', async () => {
  const { db, runtime, ctx } = harness.setup()
  const pane = 'tab_lead:22222222-2222-4222-9222-222222222222'
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_lead' ? pane : harness.coordinatorPaneKey
  )
  const task = db.createTask({ spec: 'nested lead' })
  const dispatch = createRootDispatch(db, task.id, 'term_lead', pane)
  const run = db.createRun({
    objective: 'child Run',
    coordinatorHandle: 'term_lead',
    coordinatorPaneKey: pane
  })
  db.insertMessage({
    id: 'msg_prebind',
    from: 'term_coord',
    to: `dispatch:${dispatch.id}`,
    runId: dispatch.run_id,
    subject: 'pre-bind status'
  })
  expect(
    await harness.call('orchestration.check', { terminal: 'term_lead', peek: true }, ctx)
  ).toMatchObject({ messages: [{ id: 'msg_prebind' }] })
  db.insertMessage({
    id: 'msg_child_status',
    from: 'term_child',
    to: `run:${run.id}`,
    runId: run.id,
    subject: 'child status'
  })
  db.insertMessage({
    id: 'msg_child_question',
    from: 'term_child',
    to: `run:${run.id}`,
    runId: run.id,
    subject: 'new question',
    type: 'question'
  })
  const selection = { terminal: 'term_lead', ackIds: ['msg_prebind', 'msg_child_status'] }
  await expect(harness.call('orchestration.ackMessages', selection, ctx)).resolves.toMatchObject({
    markedIds: ['msg_prebind', 'msg_child_status']
  })
  await expect(harness.call('orchestration.ackMessages', selection, ctx)).resolves.toMatchObject({
    alreadyReadIds: ['msg_prebind', 'msg_child_status']
  })
  expect(db.getMessageById('msg_prebind')?.read).toBe(1)
  expect(db.getMessageById('msg_child_question')?.read).toBe(0)
})
