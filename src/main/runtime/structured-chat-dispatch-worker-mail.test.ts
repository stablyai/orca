import './rpc/unused-default-rpc-methods.test-fixture'
// Worker mail belongs to its Dispatch mailbox; a message lost with the provider is handed over again once a later turn runs, including after restart or clear.

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
  const before = codex.connections.length
  expect(await sendUserMessage(sessionId, 'again')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
  const revived = connectionFor(sessionId)
  await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
  await settleTurn(sessionId, 0)
  await idleEdges(sessionId)
  return revived
}

describe("a chat worker's lost Dispatch mail is handed over again", () => {
  // Also covered by the restored-mail repoint a restart schedules; this pins the end result.
  it('after a restart', async () => {
    observationClock.start()
    await heldDispatchMail()
    restartRuntime()

    const revived = await nextTurn(PEER_CHAT)

    await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
    expect(isWholeMail(turnText(revived.turns[1]!))).toBe(true)
  })

  it('in the same chat after /clear', async () => {
    observationClock.start()
    await heldDispatchMail()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)

    const revived = await nextTurn(cleared)

    await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
    expect(isWholeMail(turnText(revived.turns[1]!))).toBe(true)
  })
})
