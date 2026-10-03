// What a running Codex agent writes into the journal, driven over `agentSession.*`; split from
// `structured-agent-session-integration.test.ts`, whose shared RPC harness this uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  THREAD,
  TURN,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

let harness: StructuredCodexRpcHarness

beforeEach(async () => {
  harness = await openStructuredCodexRpcHarness()
})

afterEach(async () => {
  await harness.dispose()
})

function drainStreamedEvents(): Promise<void> {
  return getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION) ?? Promise.resolve()
}

/** A chat is created at rest; its first send is what starts the agent these rows come from. */
async function sendToStart(fence: number): Promise<void> {
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'start' }] }
  await harness.ok('agentSession.send', {
    envelope: harness.envelope('agentSession.send', { body }, fence),
    body
  })
  await vi.waitFor(() =>
    expect(harness.codex.live().calls).toContainEqual(
      expect.objectContaining({ method: 'turn/start' })
    )
  )
}

describe('a running structured codex agent', () => {
  it('persists truncated command output before publishing its journal row', async () => {
    const created = await harness.ok<{ fence: number }>(
      'agentSession.create',
      harness.createIntentParams()
    )
    await sendToStart(created.fence)
    const output = 'large command output\n'.repeat(2_000)

    harness.codex.notify('item/completed', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id: 'item-large-output',
        command: 'print-many-lines',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: output
      }
    })
    await drainStreamedEvents()

    const host = getStructuredAgentSessionHost()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const item = journal.snapshot().items.find((candidate) => candidate.body?.kind === 'tool-call')
    const bounded = item?.body?.kind === 'tool-call' ? item.body.output : undefined
    expect(bounded).toMatchObject({ truncated: true, byteLength: Buffer.byteLength(output) })
  })

  it('keeps an answered prompt resolved after the provider exits', async () => {
    const created = await harness.ok<{ fence: number }>(
      'agentSession.create',
      harness.createIntentParams()
    )
    await sendToStart(created.fence)
    harness.codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
    harness.codex.notify('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id: 'item-needs-answer',
        command: 'build',
        status: 'inProgress'
      }
    })
    harness.codex.ask(9, 'item/commandExecution/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-needs-answer',
      availableDecisions: ['accept', 'decline']
    })
    await drainStreamedEvents()
    const host = getStructuredAgentSessionHost()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const approval = journal.snapshot().items.find((item) => item.body?.kind === 'approval')
    expect(approval?.body).toMatchObject({
      kind: 'approval',
      resolution: { state: 'pending' }
    })

    await harness.ok('agentSession.respondToApproval', {
      envelope: harness.envelope(
        'agentSession.respondTo:approval',
        {
          itemId: approval?.itemId,
          expectedRevision: approval?.revision,
          optionId: 'accept'
        },
        created.fence
      ),
      itemId: approval?.itemId,
      expectedRevision: approval?.revision,
      optionId: 'accept'
    })
    harness.codex.live().handlers.onExit?.(new Error('provider exited after answer'))
    await drainStreamedEvents()

    expect(
      journal.snapshot().items.find((item) => item.itemId === approval?.itemId)?.body
    ).toMatchObject({
      kind: 'approval',
      resolution: { state: 'resolved', selectedOptionId: 'accept' }
    })
  })
})
