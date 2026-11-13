import { readTestHostJournal } from '../../native-chat/agent-session-journal/journal-observation.test-support'
// Exercise real adapter connection exits/Stop during compact; fake only the Codex child, never its compaction result.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../ipc/desktop-renderer-runtime-capabilities'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost } from './records/agent-session-record-store-test-harness'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  type FakeCodexConnection,
  type StructuredCodexRpcHarness
} from '../rpc/methods/structured-sessions/structured-codex-session-rpc-test-harness'

let harness: StructuredCodexRpcHarness

beforeEach(async () => {
  // The desktop's own client: a send answers at acceptance, so one queued behind the command
  // returns while the command still runs.
  harness = await openStructuredCodexRpcHarness(DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES)
})

afterEach(async () => {
  await harness.dispose()
})

async function snapshot() {
  return await readTestHostJournal(
    await ensureStructuredAgentSessionHost(harness.hostConfig()),
    SESSION
  )
}

/** The connections that received `method`, once per call. */
function calls(method: string): FakeCodexConnection[] {
  return harness.codex.connections.flatMap((connection) =>
    connection.calls.filter((entry) => entry.method === method).map(() => connection)
  )
}

/** The child serving the thread; a model-list probe opens connections of its own. */
function threadChild(): FakeCodexConnection {
  const child = harness.codex.connections.findLast((connection) =>
    connection.calls.some(
      (entry) => entry.method === 'thread/start' || entry.method === 'thread/resume'
    )
  )
  if (!child) {
    throw new Error('no codex child opened the thread')
  }
  return child
}

async function startCompact(fence: number): Promise<string> {
  const params = {
    command: 'compact',
    envelope: harness.envelope('agentSession.conversationCommand', { command: 'compact' }, fence)
  }
  await harness.ok('agentSession.conversationCommand', params)
  return params.envelope.clientOperationId
}

async function send(text: string): Promise<void> {
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [{ type: 'text', text }] }
  await harness.ok('agentSession.send', {
    envelope: harness.envelope('agentSession.send', { body }, null),
    body
  })
}

function exitChild(): FakeCodexConnection {
  const child = threadChild()
  child.handlers.onExit?.(new Error('codex app-server exited'))
  return child
}

it('delivers what waited behind the command once its child dies mid-command, with one exit row', async () => {
  const created = await harness.ok<{ fence: number }>(
    'agentSession.create',
    harness.createIntentParams()
  )
  const compacting = harness.codex.nextRequest('thread/compact/start')
  const command = await startCompact(created.fence)
  await compacting
  await send('after the exit')

  const restarted = harness.codex.nextRequest('turn/start')
  const dead = exitChild()

  expect(await restarted).not.toBe(dead)
  expect(calls('turn/start')).toHaveLength(1)
  const settled = await snapshot()
  const turn = settled.items.find(
    (item) => item.itemId === structuredAgentSessionCommandTurn(command).itemId
  )
  expect(readAgentJournalTurn(turn?.body)?.state).toBe('interrupted')
  expect(
    settled.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
})

it('ends a command Codex has not opened a turn for by stopping its child, and the next send gets a fresh one', async () => {
  const created = await harness.ok<{ fence: number }>(
    'agentSession.create',
    harness.createIntentParams()
  )
  const compacting = harness.codex.nextRequest('thread/compact/start')
  const command = await startCompact(created.fence)
  await compacting
  const first = threadChild()
  const { itemId, turnId } = structuredAgentSessionCommandTurn(command)

  // No `turn/started` yet, so there is no provider turn to interrupt.
  await expect(
    harness.ok('agentSession.cancel', {
      envelope: harness.envelope('agentSession.cancel', { turnId }, null),
      turnId
    })
  ).resolves.toMatchObject({ cancelled: true })

  expect(first.closed).toBe(true)
  expect(first.calls.some((entry) => entry.method === 'turn/interrupt')).toBe(false)
  // The child's end, the Stop's second step, settles the command's turn.
  await vi.waitFor(async () => {
    const turn = (await snapshot()).items.find((item) => item.itemId === itemId)
    expect(readAgentJournalTurn(turn?.body)?.state).toBe('interrupted')
  })
  const restarted = harness.codex.nextRequest('turn/start')
  await send('after the stop')
  expect(await restarted).not.toBe(first)
  expect(calls('turn/start')).toHaveLength(1)
})
