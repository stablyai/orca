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

it('selectively acknowledges pre-bind Dispatch mail without disturbing an outstanding Run delivery', async () => {
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
  const delivery = db.getOrCreateRunDelivery({
    runId: run.id,
    consumerGeneration: run.consumer_generation
  })!
  expect(delivery.messages.map((message) => message.id)).toEqual([
    'msg_child_status',
    'msg_child_question'
  ])
  const receiptIdentity = {
    callerFingerprint: 'caller_run',
    requestId: 'selected_run_ack',
    method: 'orchestration.ackMessages',
    payloadHash: 'selected_run_payload'
  }
  db.beginMutationReceipt(receiptIdentity)
  ctx.recordMutationReceipt = (receipt) => {
    db.completeMutationReceipt({ ...receiptIdentity, receipt: JSON.stringify(receipt) })
  }
  const selection = { terminal: 'term_lead', ackIds: ['msg_prebind', 'msg_child_status'] }
  await expect(harness.call('orchestration.ackMessages', selection, ctx)).resolves.toMatchObject({
    markedIds: ['msg_prebind', 'msg_child_status']
  })
  expect(
    JSON.parse(db.getMutationReceipt('caller_run', 'selected_run_ack')!.receipt!)
  ).toMatchObject({
    runId: run.id,
    markedIds: ['msg_prebind', 'msg_child_status']
  })
  await expect(harness.call('orchestration.ackMessages', selection, ctx)).resolves.toMatchObject({
    alreadyReadIds: ['msg_prebind', 'msg_child_status']
  })
  expect(db.getMessageById('msg_prebind')?.read).toBe(1)
  expect(db.getMessageById('msg_child_question')?.read).toBe(0)
  expect(
    db.getOrCreateRunDelivery({ runId: run.id, consumerGeneration: run.consumer_generation })
  ).toMatchObject({
    delivery: { id: delivery.delivery.id },
    messages: [{ id: 'msg_child_status' }, { id: 'msg_child_question' }]
  })
})

it('records the Dispatch mailbox identity with the selective acknowledgment', async () => {
  const { db, runtime, ctx, activeRunId } = harness.setup()
  const pane = 'tab_worker:33333333-3333-4333-9333-333333333333'
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_worker' ? pane : harness.coordinatorPaneKey
  )
  const task = db.createTask({ spec: 'worker receipt' })
  const dispatch = createRootDispatch(db, task.id, 'term_worker', pane)
  db.insertMessage({
    id: 'msg_worker_selected',
    from: 'term_coord',
    to: `dispatch:${dispatch.id}`,
    subject: 'selected status'
  })
  const identity = {
    callerFingerprint: 'caller_worker',
    requestId: 'selected_worker_ack',
    method: 'orchestration.ackMessages',
    payloadHash: 'selected_worker_payload'
  }
  db.beginMutationReceipt(identity)
  ctx.recordMutationReceipt = (receipt) => {
    db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(receipt) })
  }
  await harness.call(
    'orchestration.ackMessages',
    { terminal: 'term_worker', ackIds: ['msg_worker_selected'] },
    ctx
  )
  expect(
    JSON.parse(db.getMutationReceipt('caller_worker', 'selected_worker_ack')!.receipt!)
  ).toMatchObject({
    runId: activeRunId,
    dispatchId: dispatch.id,
    markedIds: ['msg_worker_selected']
  })
  expect(db.getMessageById('msg_worker_selected')?.read).toBe(1)
})
