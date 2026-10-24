import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  WORKER_2_PANE,
  openChat,
  coordinatorRunAndTask,
  finishWorker,
  host,
  runtime,
  db,
  call,
  WAIT
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'

it('new QA mail wakes a failed chat holding an older unacknowledged batch, preserving FIFO replay and ack', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await finishWorker(taskId)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const turn = chat.turns[0]!
  chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
  chat.handlers.onNotification?.('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${turn.clientUserMessageId}`,
      clientId: turn.clientUserMessageId,
      content: [{ type: 'text', text: 'notice' }]
    }
  })
  await host.flushStreamedEvents(COORDINATOR)
  const first = await call('orchestration.check', {}, { sessionId: COORDINATOR })
  chat.handlers.onNotification?.('turn/completed', {
    turn: { id: 'turn-1', status: 'failed', error: { message: 'connection dropped' } }
  })
  await host.flushStreamedEvents(COORDINATOR)
  expect(chat.turns).toHaveLength(1)
  const second = await call(
    'orchestration.taskCreate',
    { spec: 'QA result' },
    { sessionId: COORDINATOR }
  )
  await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
  const replay = await call('orchestration.check', {}, { sessionId: COORDINATOR })
  expect(replay).toMatchObject({ deliveryId: first.deliveryId, replayed: true })
  const next = await call(
    'orchestration.check',
    { ack: first.deliveryId },
    { sessionId: COORDINATOR }
  )
  expect(next).toMatchObject({ count: 1, messages: [{ from_handle: 'term_worker_2' }] })
  expect(db.getUnreadMessages(`run:${runId}`)).toHaveLength(1)
})

it('recovers a proven failed notice once without successor mail, while repeated failure remains explicitly readable', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await finishWorker(taskId)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const fail = async (index: number) => {
    const turn = chat.turns[index]!
    chat.handlers.onNotification?.('turn/started', { turn: { id: `turn-${index + 1}` } })
    chat.handlers.onNotification?.('item/completed', {
      item: {
        type: 'userMessage',
        id: `echo-${turn.clientUserMessageId}`,
        clientId: turn.clientUserMessageId,
        content: [{ type: 'text', text: 'notice' }]
      }
    })
    chat.handlers.onNotification?.('turn/completed', {
      turn: {
        id: `turn-${index + 1}`,
        status: 'failed',
        error: { message: 'connection dropped' }
      }
    })
    await host.flushStreamedEvents(COORDINATOR)
  }
  await fail(0)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
  await fail(1)
  for (let edge = 0; edge < 3; edge++) {
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await host.flushStreamedEvents(COORDINATOR)
  }
  expect(chat.turns).toHaveLength(2)
  expect(db.getUnreadMessages(`run:${runId}`)[0]?.recovery_used).toBe(1)
  expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
    count: 1
  })
})
