import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  db,
  host,
  runtime,
  observationClock,
  call,
  openChat,
  settleTurn,
  startTurn,
  envelope,
  sendUserMessage,
  finishWorker,
  coordinatorRunAndTask,
  WAIT,
  turnText,
  queuedCardTexts
} from './structured-chat-coordinator-mail-rig.test-fixture'

it('holds old admitted and missed reports until real Resume while fresh reports run without releasing personal cards', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await sendUserMessage(COORDINATOR, 'personal work')
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  await startTurn(COORDINATOR, 0)
  await sendUserMessage(COORDINATOR, 'personal queued', 'queue-if-active')
  await finishWorker(taskId)
  const missed = db.insertMessage({
    from: 'term_worker',
    to: `run:${runId}`,
    runId,
    subject: 'missed old'
  })
  expect(
    await host.cancel(
      { callerKey: 'test-surface' },
      {
        envelope: envelope(COORDINATOR, 'agentSession.cancel', { turnId: 'turn-1' }),
        turnId: 'turn-1'
      }
    )
  ).toMatchObject({ ok: true })
  chat.handlers.onNotification?.('turn/completed', {
    turn: { id: 'turn-1', status: 'interrupted' }
  })
  await host.flushStreamedEvents(COORDINATOR)
  await call('orchestration.send', {
    from: 'term_worker',
    to: `run:${runId}`,
    subject: 'fresh after Stop'
  })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
  expect(turnText(chat.turns[1])).toContain('fresh after Stop')
  await settleTurn(COORDINATOR, 1, 'completed')
  await observationClock.edgesAnswered(runtime, WAIT)
  expect(chat.turns).toHaveLength(2)
  expect(await queuedCardTexts()).toHaveLength(3)
  expect(db.getMessageById(missed.id)?.delivered_at).not.toBeNull()
  const page = await host.history({ sessionId: COORDINATOR, direction: 'tail' })
  expect(page).toMatchObject({ ok: true, page: { queuePause: { reason: 'stopped' } } })
  expect(
    await host.queuedMessagesResume(
      { callerKey: 'test-surface' },
      {
        envelope: envelope(COORDINATOR, 'agentSession.queuedMessagesResume', {})
      }
    )
  ).toMatchObject({ ok: true, value: { resumed: true } })
  for (let n = 2; n < 5; n++) {
    await vi.waitFor(() => expect(chat.turns).toHaveLength(n + 1), WAIT)
    await settleTurn(COORDINATOR, n, 'completed')
  }
  expect(await queuedCardTexts()).toEqual([])
  expect(chat.steers).toEqual([])
})
