import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  host,
  openChat,
  queuedCardTexts,
  runtime,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

async function workerMailbox() {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT)) },
    { sessionId: COORDINATOR }
  )
  const mailbox = `dispatch:${idOf(dispatch)}`
  const receive = async (subject: string) => {
    const result = await call(
      'orchestration.send',
      { to: mailbox, subject },
      { sessionId: COORDINATOR }
    )
    return idOf(result.message)
  }
  const check = (ack?: string) => call('orchestration.check', { ack }, { sessionId: PEER_CHAT })
  return { chat, mailbox, receive, check }
}

describe('structured worker notices after a check without acknowledgement', () => {
  it('starts one later notice turn after the consumer settles without acknowledging', async () => {
    const { chat, mailbox, receive, check } = await workerMailbox()
    const first = await receive('First guidance')
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(turnText(chat.turns[0]!)).toContain('You have 1 orchestration message.')
    const checked = await check()
    expect(checked.messages).toEqual([expect.objectContaining({ id: first })])
    expect(db.hasOutstandingMailboxDelivery(mailbox)).toBe(true)
    await settleTurn(PEER_CHAT, 0)

    const later = await receive('Later guidance')
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toContain('You have 1 orchestration message.')
    const replayed = await check()
    expect(replayed.deliveryId).toBe(checked.deliveryId)
    expect(replayed.messages).toEqual([expect.objectContaining({ id: first })])
    if (typeof checked.deliveryId !== 'string') {
      throw new Error('Expected a consuming delivery')
    }
    const next = await check(checked.deliveryId)
    expect(next.messages).toEqual([expect.objectContaining({ id: later })])
    await settleTurn(PEER_CHAT, 1)
    runtime.deliverPendingMessagesForHandle(mailbox)
    runtime.onStructuredSessionStatusForMail({ sessionId: PEER_CHAT, status: 'idle' })
    expect(chat.turns).toHaveLength(2)
  })

  it('queues later mail once while the checked batch is active, without starting a second provider turn', async () => {
    const { chat, mailbox, receive, check } = await workerMailbox()
    await receive('First guidance')
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
    chat.handlers.onNotification?.('item/completed', {
      item: {
        type: 'userMessage',
        id: `echo-${chat.turns[0]!.clientUserMessageId}`,
        clientId: chat.turns[0]!.clientUserMessageId,
        content: [{ type: 'text', text: turnText(chat.turns[0]!) }]
      }
    })
    await host.flushStreamedEvents(PEER_CHAT)
    await check()
    expect(db.hasOutstandingMailboxDelivery(mailbox)).toBe(true)
    await receive('Later guidance while working')
    await vi.waitFor(async () => expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1), WAIT)
    runtime.deliverPendingMessagesForHandle(mailbox)
    runtime.deliverPendingMessagesForHandle(mailbox)
    expect(chat.turns).toHaveLength(1)
    expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1)

    await settleTurn(PEER_CHAT, 0)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(PEER_CHAT, 1)
    expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(0)
    expect(chat.turns).toHaveLength(2)
  })
})
