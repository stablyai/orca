import { cp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
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
  await closeTestJournalHostDatabases()
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

/** Restart over copied files without open handles or owned providers. */
async function relaunch(): Promise<StructuredAgentSessionHost> {
  const before = hostTestState()
  await before.host.flushAllStreamedEvents()
  await before.store.renewLeases([])
  const relaunched = `${before.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process retains no locks.
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

// A newer background approval can block queues forever; a direct send starts the turn that cancels it.
it("takes a send past a newer Orca's live approval, and the next turn's card cancel settles it", async () => {
  // Model providers whose card Cancel requires the live turn’s Stop path.
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
  // Match real adapters’ generation identity so Stop can settle the turn.
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
  // Type-valid whitespace call IDs fail persisted-reader validation.
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
