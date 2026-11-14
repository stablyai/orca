import { afterEach, expect, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { journalOf, queuedCardTexts } from './structured-chat-coordinator-journal.test-fixture'
import {
  COORDINATOR,
  WAIT,
  coordinatorRunAndTask,
  finishWorker,
  host,
  openChat,
  sendUserMessage,
  settleTurn as settleProviderTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'

const starts = new Map<string, () => void>()
afterEach(() => {
  for (const release of starts.values()) {
    release()
  }
  starts.clear()
})

/** Keep admission unanswered while a custody scenario needs an unconsumed card. */
export async function busyChat(sessionId: string, startReply?: Promise<void>) {
  const reply = Promise.withResolvers<void>()
  starts.set(sessionId, reply.resolve)
  const chat = await openChat(sessionId)
  const request = chat.request
  chat.request = async (...args) => {
    const response = await request(...args)
    if (args[0] === 'turn/start') {
      await (startReply ?? reply.promise)
    }
    return response
  }
  expect(await sendUserMessage(sessionId, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(sessionId)
  return chat
}

export async function settleTurn(sessionId: string, turnIndex: number) {
  starts.get(sessionId)?.()
  await settleProviderTurn(sessionId, turnIndex)
}

/** Editing blocks automatic consumption; the person's explicit Send can still hand the card over. */
export async function editableMail() {
  const chat = await busyChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await finishWorker(taskId)
  await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
  const journal = journalOf(COORDINATOR)
  const [card] = await journal.queuedMessages.list()
  expect(
    await journal.queuedMessages.editLeases.acquire(
      { callerKey: 'test-surface', editId: 'mail-editor' },
      {
        messageId: card!.messageId,
        fingerprint: agentSessionSendBodyFingerprint(COORDINATOR, card!.body)
      }
    )
  ).toMatchObject({ status: 'held' })
  starts.get(COORDINATOR)?.()
  await host.collaboratorsForTests().conversationDelivery.loop.wake(COORDINATOR)
  return { chat, runId }
}
