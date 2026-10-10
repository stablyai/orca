// An agent that dies while another connection holds the database: its exit's settlement fails at
// once and waits for the retry, so the journal still says the turn runs. Until the settlement
// lands, every frame a reader gets reads that turn as the settlement will write it, interrupted:
// the chat's latest turn, the session list's row (which the tab and sidebar show), and the host's
// working answer that decides a queued card's Send. Never Working, never a finish with no verdict.

import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { runningStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  exitChild,
  leaveUnfinishedWork,
  turnState
} from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  holdWriteLock,
  releaseWriteLocks
} from './structured-agent-session-write-lock.test-fixture'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await releaseWriteLocks()
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

/** Every frame a chat client and the session list receive, as each reduces it. */
function recordFrames(current: QueuedMessageTestRig) {
  const chats: StructuredAgentSessionState[] = []
  const rows: AgentSessionStatusSummary[] = []
  let chat = EMPTY_STRUCTURED_AGENT_SESSION
  current.host.subscribe({
    id: 'chat-1',
    sessionId: SESSION,
    emit: (event) => {
      chat = reduceStructuredAgentSession(chat, { type: 'event', event: structuredClone(event) })
      chats.push(chat)
    }
  })
  current.host.subscribeStatus({
    id: 'list-1',
    emit: (event) => {
      const row =
        event.type === 'status'
          ? event.session
          : event.type === 'snapshot'
            ? event.sessions.find((session) => session.sessionId === SESSION)
            : undefined
      if (row?.sessionId === SESSION) {
        rows.push(structuredClone(row))
      }
    }
  })
  return { chats, rows }
}

it('reads the dead turn interrupted in every frame until its settlement lands', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  rig = await createQueuedMessageTestRig({ restartable: true })
  const current = rig
  await current.workingSend()
  await current.send('after this', 'queue-if-active').result
  await leaveUnfinishedWork(current)
  const frames = recordFrames(current)
  await vi.waitFor(() => expect(frames.chats.at(-1)?.working).toBe(true))
  const { released } = await holdWriteLock(current.root, 1_200)
  const before = { chats: frames.chats.length, rows: frames.rows.length }

  await exitChild(current)
  const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
  await released
  // Nothing landed: what the frames read is derived from the death alone.
  expect(turnState(current)).toBe('running')

  const chats = frames.chats.slice(before.chats)
  const rows = frames.rows.slice(before.rows)
  expect(chats.length).toBeGreaterThan(0)
  expect(rows.length).toBeGreaterThan(0)
  for (const chat of [...chats, page.ok ? page.page : null]) {
    expect(chat?.latestTurn?.turn.state).toBe('interrupted')
    expect(chat?.working).toBe(false)
    // So no turn runs to steer into: the card's control is Send.
    expect(chat?.nextQueuedMessageId ?? null).toBeNull()
  }
  for (const chat of chats) {
    expect(runningStructuredAgentSessionTurnId(chat)).toBeNull()
  }
  for (const row of rows) {
    expect(row).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
  }

  // Once the lock lifts, the retry writes what the frames already said.
  await vi.waitFor(() => expect(turnState(current)).toBe('interrupted'), { timeout: 8_000 })
}, 20_000)
