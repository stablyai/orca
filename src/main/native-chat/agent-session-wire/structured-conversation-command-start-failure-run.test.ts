// A run of failed starts against conversation commands. A command's failed start always writes its
// own row, which never speaks for a message's; and a send the provider accepted ends a run, a
// /compact Codex takes without an item of its own too. Against the real host, store and journal.

import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  isStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRowIdentity
} from '../../../shared/structured-agent-session-start-failure-row-key'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let state: ReturnType<typeof hostTestState>
let compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>>

beforeEach(() => {
  state = hostTestState()
  // Codex's ack: the provider took the command, with no item of its own.
  compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
  Object.assign(state.host.deps.adapter, { compact, closeSession: vi.fn(async () => true) })
})

/** The provider ends the command it took, as its translator writes it. */
function finishCompact(): void {
  const { command } = compact.mock.calls.at(-1)![0]
  const events = state.acquire.mock.calls.at(-1)![0].events!
  events.appendLifecycleBatch!(
    `turn-completed:${command.clientMessageId}`,
    [
      {
        kind: 'item',
        identity: command.identity,
        body: {
          ...command.running,
          state: 'completed',
          outcome: 'success',
          completedAt: HOST_TEST_NOW
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    { lifecycle: true }
  )
}

/** The chat's child is gone; the next start it needs crashes the same way each time. */
async function startsCrash(times?: 'once'): Promise<void> {
  await state.host.close(SESSION, 'evict')
  const crash = new Error('codex app-server exited (code 1)')
  if (times === 'once') {
    state.acquire.mockRejectedValueOnce(crash)
  } else {
    state.acquire.mockRejectedValue(crash)
  }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const params = { envelope: envelope('agentSession.send', { body }), body }
  await expect(state.host.send(CALLER, params)).resolves.toMatchObject({ ok: true })
  return params.envelope.clientOperationId
}

async function compactCommand(): Promise<string> {
  const params = {
    command: 'compact' as const,
    envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
  }
  await expect(state.host.conversationCommand(CALLER, params)).resolves.toMatchObject({ ok: true })
  return params.envelope.clientOperationId
}

async function settled(clientMessageId: string, dispatchState: 'accepted' | 'rejected') {
  await vi.waitFor(async () =>
    expect(
      (await state.host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === clientMessageId
      )
    ).toMatchObject({ dispatchState })
  )
}

async function startRows(): Promise<string[]> {
  return (await state.host.journalSnapshot(SESSION)).items.flatMap((item) =>
    isStructuredAgentSessionStartFailureRow(item.itemId) ? [item.itemId] : []
  )
}

const rowFor = (id: string) =>
  agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(id))

it('starts a new run after a /compact the provider took with no item of its own', async () => {
  await attach()
  await startsCrash('once')
  const first = await send('first')
  await settled(first, 'rejected')
  const compacted = await compactCommand()
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
  await settled(compacted, 'accepted')
  finishCompact()
  await state.host.flushStreamedEvents(SESSION)

  await startsCrash('once')
  const second = await send('second')
  await settled(second, 'rejected')

  // The same crash, but a turn was delivered between: news, with its own row.
  expect(await startRows()).toEqual([rowFor(first), rowFor(second)])
})

it('gives a /compact that fails like the message before it a row of its own', async () => {
  await attach()
  await startsCrash()
  const first = await send('first')
  await settled(first, 'rejected')

  const compacted = await compactCommand()
  await settled(compacted, 'rejected')

  expect(await startRows()).toEqual([rowFor(first), rowFor(compacted)])
  // A client that hides rejected messages still reads the command's own row.
  const snapshot = await state.host.journalSnapshot(SESSION)
  const drawn = projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions, {
    rejectedInPlace: false
  })
  expect(drawn.flatMap((message) => message.blocks)).toContainEqual(
    expect.objectContaining({ text: "Codex couldn't restart. Run /compact again." })
  )
})

it('gives a message that fails like the /compact before it a row of its own', async () => {
  await attach()
  await startsCrash()
  const compacted = await compactCommand()
  await settled(compacted, 'rejected')

  const later = await send('later')
  await settled(later, 'rejected')

  expect(await startRows()).toEqual([rowFor(compacted), rowFor(later)])
})
