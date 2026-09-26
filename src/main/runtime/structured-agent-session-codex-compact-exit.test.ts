// A Codex child that exits while `/compact` runs, observed the way the shipping adapter observes
// it: the app-server connection's own exit callback, not a hand-fed compaction result.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../ipc/desktop-renderer-runtime-capabilities'
import { structuredAgentSessionCommandTurn } from '../native-chat/agent-session-wire/structured-agent-session-command-turn'
import { ensureStructuredAgentSessionHost } from './structured-agent-session-runtime'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  type FakeCodexConnection,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

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
  return (await ensureStructuredAgentSessionHost(harness.hostConfig())).journalSnapshot(SESSION)
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
  const command = await startCompact(created.fence)
  await vi.waitFor(() => expect(calls('thread/compact/start')).toHaveLength(1))
  await send('after the exit')

  const dead = exitChild()

  await vi.waitFor(() => expect(calls('turn/start')).toHaveLength(1))
  expect(calls('turn/start')[0]).not.toBe(dead)
  const settled = await snapshot()
  const turn = settled.items.find(
    (item) => item.itemId === structuredAgentSessionCommandTurn(command).itemId
  )
  expect(readAgentJournalTurn(turn?.body)?.state).toBe('interrupted')
  expect(
    settled.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
})

it('runs a later command after Stop named the one whose child died', async () => {
  const created = await harness.ok<{ fence: number }>(
    'agentSession.create',
    harness.createIntentParams()
  )
  const command = await startCompact(created.fence)
  await vi.waitFor(() => expect(calls('thread/compact/start')).toHaveLength(1))

  const dead = exitChild()
  await vi.waitFor(async () => {
    const turn = (await snapshot()).items.find(
      (item) => item.itemId === structuredAgentSessionCommandTurn(command).itemId
    )
    expect(readAgentJournalTurn(turn?.body)?.state).toBe('interrupted')
  })
  const { turnId } = structuredAgentSessionCommandTurn(command)
  await harness.ok('agentSession.cancel', {
    envelope: harness.envelope('agentSession.cancel', { turnId }, null),
    turnId
  })

  // Nothing the dead command left behind holds the queue or refuses the next one.
  const later = await startCompact(created.fence)
  await vi.waitFor(() => expect(calls('thread/compact/start')).toHaveLength(2))
  expect(calls('thread/compact/start')[1]).not.toBe(dead)
  const turn = (await snapshot()).items.find(
    (item) => item.itemId === structuredAgentSessionCommandTurn(later).itemId
  )
  expect(readAgentJournalTurn(turn?.body)?.state).toBe('running')
})
