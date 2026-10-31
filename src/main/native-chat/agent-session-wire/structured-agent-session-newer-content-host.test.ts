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
