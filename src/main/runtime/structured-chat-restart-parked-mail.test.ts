import './rpc/unused-default-rpc-methods.test-fixture'
// Mail parked for an idle chat across a restart is a debt the restart re-derives. The database's
// restored-mail repoint can run before any host can take it and park the mail for the chat's next
// edge, so startup opens that one chat, and its idle edge points the mail again unprompted.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  codex,
  connectionFor,
  coordinatorRunAndTask,
  db,
  host,
  installHost,
  openChat,
  restartRuntime,
  runtime,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const POINTER = /orchestration message/
/** `MailPointerRepointScheduler`'s delay. */
const MAIL_REPOINT_DELAY_MS = 2_000

/** A chat worker that took its Dispatch and went idle; its Dispatch's mailbox. */
async function idleDispatchWorker(): Promise<{ mailbox: string; runId: string }> {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { runId, taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  const mailbox = `dispatch:${idOf(dispatch)}`
  await call('orchestration.send', { to: mailbox, subject: 'start' }, { sessionId: COORDINATOR })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  await settleTurn(PEER_CHAT, 0)
  expect(db.getUndeliveredUnreadMessages(mailbox, undefined, {})).toHaveLength(0)
  return { mailbox, runId }
}

describe('a restart re-derives mail parked for an idle chat', () => {
  it('points it again with no user action, opening only that chat', async () => {
    const { mailbox, runId } = await idleDispatchWorker()
    await stopStructuredAgentSessionRuntime()
    // Mail that arrived while no host could take it.
    db.insertMessage({
      runId,
      from: formatOrcaSessionAddress(testOrcaSessionId(COORDINATOR)),
      to: mailbox,
      subject: 'more'
    })
    restartRuntime()
    // The database's own restored-mail repoint runs while no host can take it, and parks the mail.
    await new Promise((resolve) => setTimeout(resolve, MAIL_REPOINT_DELAY_MS + 500))
    await installHost()
    expect(db.getUndeliveredUnreadMessages(mailbox, undefined, {})).toHaveLength(1)
    const before = codex.connections.length

    await runtime.restoreStructuredAgentSessionTabs()

    expect(host.hasSession(COORDINATOR)).toBe(false)
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(PEER_CHAT)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(turnText(revived.turns[0]!)).toMatch(POINTER)
    await settleTurn(PEER_CHAT, 0)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(mailbox, undefined, {})).toHaveLength(0),
      WAIT
    )
  })
})
