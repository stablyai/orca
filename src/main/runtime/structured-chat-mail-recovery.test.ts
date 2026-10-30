vi.mock('../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Mail fixtures must not install a runtime')
  }
}))

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
  WAIT,
  settleTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'

it('new mail wakes a failed chat holding an independent unacknowledged check, preserving FIFO replay and ack', async () => {
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

it('a failed ordinary report is spent at source and remains independently readable without an automatic provider retry', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await finishWorker(taskId)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  await settleTurn(COORDINATOR, 0, 'failed')
  for (let edge = 0; edge < 3; edge++) {
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await host.flushStreamedEvents(COORDINATOR)
  }
  expect(chat.turns).toHaveLength(1)
  expect(db.getUnreadMessages(`run:${runId}`)[0]?.delivered_at).not.toBeNull()
  expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
    count: 1
  })
})
