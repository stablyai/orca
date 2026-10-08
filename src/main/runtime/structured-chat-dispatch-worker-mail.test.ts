import './rpc/unused-default-rpc-methods.test-fixture'
// A chat worker's coordinator mail lands in its Dispatch's mailbox. When the pointer to it was held
// (the provider died before taking it), the chat's next idle edge points it again, after a restart
// or in the session a /clear continued the chat in, as it does for a chat's own mail.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  clearChat,
  codex,
  connectionFor,
  coordinatorRunAndTask,
  db,
  openChat,
  restartRuntime,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const POINTER = /orchestration message/

async function idleEdges(sessionId: string): Promise<void> {
  runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
  runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 400))
}

/** Coordinator mail to the peer chat's Dispatch, its pointer lost with the provider. */
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
  expect(turnText(chat.turns[0]!)).toMatch(POINTER)
  chat.handlers.onExit?.(new Error('provider died before the echo'))
  await idleEdges(PEER_CHAT)
  expect(chat.turns).toHaveLength(1)
  expect(db.getUndeliveredUnreadMessages(mailbox, undefined, {})).toHaveLength(1)
  return mailbox
}

/** The chat's next turn, the person's; resolves to the session's provider once its edges ran. */
async function nextTurn(sessionId: string): Promise<{ turns: { text: string }[] }> {
  const before = codex.connections.length
  expect(await sendUserMessage(sessionId, 'again')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
  const revived = connectionFor(sessionId)
  await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
  await settleTurn(sessionId, 0)
  await idleEdges(sessionId)
  return revived
}

describe("a chat worker's held Dispatch mail is pointed again", () => {
  // Also covered by the restored-mail repoint a restart schedules; this pins the end result.
  it('after a restart', async () => {
    await heldDispatchMail()
    restartRuntime()

    const revived = await nextTurn(PEER_CHAT)

    await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
    expect(turnText(revived.turns[1]!)).toMatch(POINTER)
  })

  it('in the session a /clear continued the chat in', async () => {
    await heldDispatchMail()
    const successor = await clearChat(PEER_CHAT)

    const revived = await nextTurn(successor)

    await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
    expect(turnText(revived.turns[1]!)).toMatch(POINTER)
  })
})
