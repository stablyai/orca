// Worker mail belongs to its Dispatch mailbox; a message the provider may have taken before it died is never handed over again, even after a later turn, a restart or a clear: check keeps it.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  clearChat,
  connectionFor,
  coordinatorRunAndTask,
  db,
  host,
  isWholeMail,
  observationClock,
  openChat,
  restartRuntime,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

async function idleEdges(sessionId: string): Promise<void> {
  runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
  runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
  await observationClock.observe(400)
  await host.flushStreamedEvents(sessionId)
}

/** Coordinator mail to the peer chat's Dispatch, handed whole to a provider that died before taking it. */
async function heldDispatchMail(): Promise<string> {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  const mailbox = `dispatch:${idOf(dispatch)}`
  await call('orchestration.send', { to: mailbox, subject: 'more' }, { sessionId: COORDINATOR })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(isWholeMail(turnText(chat.turns[0]!))).toBe(true)
  chat.handlers.onExit?.(new Error('provider died before the echo'))
  await idleEdges(PEER_CHAT)
  expect(chat.turns).toHaveLength(1)
  // Delivered but still unread: edges before a later turn send nothing more.
  expect(db.getUnreadMessages(mailbox)).toHaveLength(1)
  return mailbox
}

/** The chat's next turn, the person's; resolves to the session's provider once its edges ran. */
async function nextTurn(sessionId: string): Promise<{ turns: { text: string }[] }> {
  expect(await sendUserMessage(sessionId, 'again')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(connectionFor(sessionId).turns).toHaveLength(1), WAIT)
  const revived = connectionFor(sessionId)
  await settleTurn(sessionId, 0)
  await idleEdges(sessionId)
  return revived
}

describe("a chat worker's in-doubt Dispatch mail is not handed over again", () => {
  it('after a restart and a later turn', async () => {
    observationClock.start()
    const mailbox = await heldDispatchMail()
    restartRuntime()

    const revived = await nextTurn(PEER_CHAT)

    expect(revived.turns).toHaveLength(1)
    expect(db.getUnreadMessages(mailbox)).toHaveLength(1)
  })

  it('in the same chat after /clear and a later turn', async () => {
    observationClock.start()
    const mailbox = await heldDispatchMail()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)

    const revived = await nextTurn(cleared)

    expect(revived.turns).toHaveLength(1)
    expect(db.getUnreadMessages(mailbox)).toHaveLength(1)
  })
})
