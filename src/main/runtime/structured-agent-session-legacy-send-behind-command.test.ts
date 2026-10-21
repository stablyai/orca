// A client that predates accepted-send replies (every phone build) has its send reply held until
// handover. A message queued behind `/compact` is handed over only when the compaction ends, so
// that reply answers once the message waits behind the running command instead.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { ensureStructuredAgentSessionHost } from './structured-agent-session-runtime'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  THREAD,
  type FakeCodexConnection,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

const COMPACTION_TURN = 'compaction-turn'
// Far under the phone's 15 s send timeout, and far over a handover that is already due.
const PROMPT_REPLY_MS = 2_000

let harness: StructuredCodexRpcHarness

beforeEach(async () => {
  // The harness's default client is the phone's: pending replies, but not accepted-send.
  harness = await openStructuredCodexRpcHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function calls(method: string): FakeCodexConnection[] {
  return harness.codex.connections.flatMap((connection) =>
    connection.calls.filter((entry) => entry.method === method).map(() => connection)
  )
}

function send(text: string): Promise<{ submission: AgentJournalSubmission }> {
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [{ type: 'text', text }] }
  return harness.ok('agentSession.send', {
    envelope: harness.envelope('agentSession.send', { body }, null),
    body
  })
}

function promptly<T>(reply: Promise<T>): Promise<T> {
  return Promise.race([
    reply,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('the send reply waited out the command')), PROMPT_REPLY_MS)
    )
  ])
}

it('answers a send queued behind /compact at once, and delivers it once after the compaction', async () => {
  const created = await harness.ok<{ fence: number }>(
    'agentSession.create',
    harness.createIntentParams()
  )
  await harness.ok('agentSession.conversationCommand', {
    command: 'compact',
    envelope: harness.envelope(
      'agentSession.conversationCommand',
      { command: 'compact' },
      created.fence
    )
  })
  await vi.waitFor(() => expect(calls('thread/compact/start')).toHaveLength(1))

  const { submission } = await promptly(send('after the compaction'))

  expect(submission).toMatchObject({ dispatchState: 'pending' })
  expect(submission.handedOverAt).toBeUndefined()
  expect(calls('turn/start')).toHaveLength(0)

  harness.codex.notify('turn/started', { threadId: THREAD, turn: { id: COMPACTION_TURN } })
  harness.codex.notify('item/completed', {
    threadId: THREAD,
    turnId: COMPACTION_TURN,
    item: { type: 'contextCompaction', id: 'compaction' }
  })
  harness.codex.notify('turn/completed', {
    threadId: THREAD,
    turn: { id: COMPACTION_TURN, status: 'completed' }
  })

  await vi.waitFor(() => expect(calls('turn/start')).toHaveLength(1))
  const journal = await (
    await ensureStructuredAgentSessionHost(harness.hostConfig())
  ).journalSnapshot(SESSION)
  expect(
    journal.submissions.filter((entry) => entry.clientMessageId === submission.clientMessageId)
  ).toEqual([expect.objectContaining({ handedOverAt: expect.any(Number) })])
  // Nothing re-sent it: the host delivered the one message once.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(calls('turn/start')).toHaveLength(1)
})

it('still holds the reply of a send that no command is holding until it is handed over', async () => {
  await harness.ok('agentSession.create', harness.createIntentParams())

  // The first send starts the child; the reply waits out that start and the handover.
  const { submission } = await promptly(send('first message'))

  expect(submission.handedOverAt).toEqual(expect.any(Number))
  await vi.waitFor(() => expect(calls('turn/start')).toHaveLength(1))
})
