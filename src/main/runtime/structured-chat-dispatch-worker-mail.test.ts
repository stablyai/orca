import './rpc/unused-default-rpc-methods.test-fixture'
// A chat worker's coordinator mail lands in its Dispatch's mailbox. When the pointer to it was held
// (the provider died before taking it), the chat's next idle edge points it again, after a restart
// or in the same chat after /clear, as it does for a chat's own mail.

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
  observationClock,
  openChat,
  restartRuntime,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText,
  MAIL
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

async function idleEdges(sessionId: string): Promise<void> {
  runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
  runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
  await observationClock.observe(400)
  await host.flushStreamedEvents(sessionId)
}

/** Coordinator mail to the peer chat's Dispatch, its send lost with the provider. */
async function heldDispatchMail(): Promise<{ mailbox: string; messageId: string }> {
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
  expect(turnText(chat.turns[0]!)).toMatch(MAIL)
  chat.handlers.onExit?.(new Error('provider died before the echo'))
  await idleEdges(PEER_CHAT)
  expect(chat.turns).toHaveLength(1)
  expect(db.getUndeliveredUnreadMessages(mailbox, undefined, {})).toHaveLength(1)
  return { mailbox, messageId: db.getUndeliveredUnreadMessages(mailbox, undefined, {})[0]!.id }
}

/** Settle the revived provider's first turn; recovered mail may precede the person's send. */
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

async function expectRecoveredMail(
  sessionId: string,
  revived: { turns: { text: string }[] },
  held: { mailbox: string; messageId: string }
): Promise<void> {
  await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
  const texts = revived.turns.map(turnText)
  expect(texts.filter((text) => text === 'again')).toHaveLength(1)
  const mailIndex = texts.findIndex((text) => MAIL.test(text))
  expect(texts.filter((text) => MAIL.test(text))).toEqual([
    expect.stringContaining(`reply --id ${held.messageId}`)
  ])
  if (mailIndex > 0) {
    await settleTurn(sessionId, mailIndex)
  }
  await vi.waitFor(
    () => expect(db.getUndeliveredUnreadMessages(held.mailbox, undefined, {})).toEqual([]),
    WAIT
  )
}

describe("a chat worker's held Dispatch mail is sent again", () => {
  // Also covered by the restored-mail repoint a restart schedules; this pins the end result.
  it('after a restart', async () => {
    observationClock.start()
    const held = await heldDispatchMail()
    restartRuntime()

    const revived = await nextTurn(PEER_CHAT)

    await expectRecoveredMail(PEER_CHAT, revived, held)
  })

  it('in the same chat after /clear', async () => {
    observationClock.start()
    const held = await heldDispatchMail()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)

    const revived = await nextTurn(cleared)

    await expectRecoveredMail(cleared, revived, held)
  })
})
