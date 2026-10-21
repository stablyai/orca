// On a real host: what a newer Orca left in a chat, and a provider row the reader would reject,
// never leave the chat unable to take its next message.

import { cp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const relaunchedRoots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function providerEvents() {
  const events = hostTestState().acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no acquired provider')
  }
  return events
}

function emit(ordinal: number, body: AgentJournalItemBody): void {
  providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal },
    body,
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function send(host: StructuredAgentSessionHost, text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
}

async function historyBodies(host: StructuredAgentSessionHost): Promise<AgentJournalItemBody[]> {
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return page.page.items.map((item) => item.body)
}

/** A restarted process over the same files, holding no chat open and owning no provider. */
async function relaunch(): Promise<StructuredAgentSessionHost> {
  const before = hostTestState()
  await before.host.flushAllStreamedEvents()
  await before.store.renewLeases([])
  const relaunched = `${before.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(before.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  const store = await openTestAgentSessionRecordStore(relaunched)
  const host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  return host
}

// A subject kind this build does not know.
const NEWER_APPROVAL: AgentJournalItemBody = JSON.parse(
  JSON.stringify({
    kind: 'approval',
    title: 'Review proposed change',
    detail: null,
    subject: { kind: 'diff', path: 'a.ts', text: 'not a plan' },
    options: [{ id: 'allow', label: 'Approve' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
)

it("settles a newer Orca's pending approval as it was, and the chat takes its next message", async () => {
  await attach()
  // Still pending when its provider went away.
  emit(7, NEWER_APPROVAL)
  const host = await relaunch()

  expect(await send(host, 'after the newer approval')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(hostTestState().dispatch).toHaveBeenCalled())

  const approval = (await historyBodies(host)).find((body) => body.kind === 'approval')
  expect(approval).toMatchObject({
    subject: { kind: 'diff', path: 'a.ts', text: 'not a plan' },
    resolution: { state: 'cancelled' }
  })
  await host.flushAllStreamedEvents()
})

// A newer host's background agent can hold such an approval while no turn runs. A queued send would
// wait behind it forever; the plain send the client makes instead starts a turn, whose card cancel
// then settles it.
it("takes a send past a newer Orca's live approval, and the next turn's card cancel settles it", async () => {
  // A provider whose card Cancel goes through the Stop: a card no live turn raised is declined.
  const dismissPrompt = vi.fn(async ({ commit }: { commit: () => Promise<void> }) => commit())
  Object.assign(hostTestState().host.deps.adapter, {
    routePromptCancel: () => ({ kind: 'stop' }),
    dismissPrompt
  })
  await attach()
  emit(7, NEWER_APPROVAL)
  const { host } = hostTestState()
  await host.flushStreamedEvents(SESSION)

  const body = hostTestMessage('queued behind it')
  const queuedFields = { body, delivery: 'queue-if-active' as const }
  expect(
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', queuedFields),
      ...queuedFields
    })
  ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
  expect(hostTestState().dispatch).not.toHaveBeenCalled()

  const sent = await send(host, 'carry on')
  expect(sent).toMatchObject({ ok: true, value: { submission: expect.any(Object) } })
  await vi.waitFor(() => expect(hostTestState().dispatch).toHaveBeenCalledOnce())
  providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 8 },
    { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: NOW },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)

  const card = (await host.journalSnapshot(SESSION)).items.find(
    (item) => item.body.kind === 'approval'
  )!
  const fields = {
    turnId: 'turn-2',
    prompt: { itemId: card.itemId, expectedRevision: card.revision }
  }
  expect(
    await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
  ).toMatchObject({ ok: true })
  expect(dismissPrompt).toHaveBeenCalledWith(expect.objectContaining({ answer: true }))
  expect(hostTestState().cancelTurn).not.toHaveBeenCalled()
  expect((await historyBodies(host)).find((entry) => entry.kind === 'approval')).toMatchObject({
    subject: { kind: 'diff' },
    resolution: { state: 'cancelled' }
  })
  await host.flushAllStreamedEvents()
})

it('ends a turn whose provider output would not read back as failed, and the next send works', async () => {
  const closeSession = vi.fn(async () => true)
  Object.assign(hostTestState().host.deps.adapter, { closeSession })
  // A provider that names its generation, as the real adapters do, so its stop settles the turn.
  const { acquire } = hostTestState()
  const acquired = acquire.getMockImplementation()!
  acquire.mockImplementation(async (input) => ({
    ...(await acquired(input)),
    acquisitionGeneration: `generation-${acquire.mock.calls.length}`
  }))
  await attach()
  emit(1, {
    kind: 'status',
    text: 'Turn started',
    turnLifecycle: { turnId: 'turn-1', state: 'running', startedAt: NOW }
  })
  emit(2, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'written first' }] })
  // TypeScript accepts it; the persisted reader rejects a call id that is only spaces.
  emit(3, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: null, callId: '  ' }]
  })
  const { host, store } = hostTestState()
  await vi.waitFor(() => {
    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })
  })

  // The turn is over, with the notice any failed journal write gives.
  expect(await historyBodies(host)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'turn', turnId: 'turn-1', state: 'interrupted' }),
      expect.objectContaining({ kind: 'status', failure: { kind: 'hostFault' } })
    ])
  )
  expect(await send(host, 'the next message')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(hostTestState().acquire).toHaveBeenCalledTimes(2))

  const reopened = await relaunch()
  expect(await historyBodies(reopened)).toContainEqual(
    expect.objectContaining({ blocks: [{ type: 'text', text: 'written first' }] })
  )
  await reopened.flushAllStreamedEvents()
})
