import {
  readTestHostJournal,
  readTestJournalItems
} from '../../../agent-session-journal/journal-observation.test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  THREAD_ID as THREAD,
  adapterFor,
  acquireReadyCodexForTest,
  identityFor,
  fakeCodex
} from '../../../../codex/structured/session-lifecycle/codex-structured-session-adapter-fixture'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { CodexStructuredSessionAdapter } from '../../../../codex/structured/session-lifecycle/codex-structured-session-adapter'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data.test-fixture'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from './structured-agent-session-logger.test-fixture'
import { claudeAndCodexDeclared } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: Awaited<ReturnType<typeof openTestAgentSessionRecordStore>>
let host: StructuredAgentSessionHost
let codex: ReturnType<typeof fakeCodex>
/** Read at each start, so a test can say what the next start resumes. */
let launch: { resumeThreadId?: string | null }
let adapter: CodexStructuredSessionAdapter

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-stop-row-'))
  resetHostTestOperationIds()
  codex = fakeCodex()
  store = await openTestAgentSessionRecordStore(root)
  // The runtime's wiring: an echo accepts its send, and every exit reaches the host.
  launch = {}
  adapter = adapterFor(codex, launch, [], {
    onDispatchSettledLate: (settlement) => host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
        void host.handleAdapterEvent(event)
      }
    }
  })
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: recordingStructuredAgentSessionLogger().logger,
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: await openTestAgentSessionDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

it('isolates legacy acquired history from live matching and saves exact proof before optional overflow', async () => {
  const journal = () => host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const body = hostTestMessage('same input')
  for (const id of ['U', 'K', 'V']) {
    await journal().appendSubmission({
      clientMessageId: id,
      body,
      payloadFingerprint: id,
      fence: 1,
      origin: 'client',
      handoverRecorded: true
    })
    await journal().resolveDispatch({ clientMessageId: id, state: 'unknown', fence: 1 })
  }
  await journal().write({
    kind: 'epoch-replace',
    reason: 'handle_forked',
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    items: [{ identity: { provider: 'orca', clientMessageId: 'U' }, body, ownerFence: 1 }]
  })
  expect((await journal().reads.item('orca:U'))?.revision).toBeGreaterThan(1)
  const user = (id: string | null) => ({
    type: 'userMessage',
    id: 'old-user',
    clientId: id,
    content: [{ type: 'text', text: 'same input', text_elements: [] }]
  })
  const oldTurn = (items: unknown[]) => ({ id: 'legacy-turn', status: 'completed', items })
  const pages = vi.fn(() => {
    throw new Error('old provider has no pagination')
  })
  codex.routes['thread/turns/list'] = pages
  const reopen = async (returned: unknown[]) => {
    await host.close(SESSION, 'evict')
    launch.resumeThreadId = THREAD
    codex.routes['thread/resume'] = () => ({ thread: { id: THREAD, turns: returned } })
    await readTestHostJournal(host, SESSION)
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({
      journal: journal(),
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      publish: () => {}
    })
    const resumed = adapterFor(codex, { resumeThreadId: THREAD }, [], {
      onDispatchSettledLate: (settlement) => host.settleLateDispatch(settlement)
    })
    try {
      await acquireReadyCodexForTest(resumed, {
        identity: identityFor(SESSION),
        fence: store.getRecord(SESSION)!.lease.runtimeFence,
        spawnToken: 'recorded-fixture-child',
        events: deferred.sink
      })
      await deferred.drained()
    } finally {
      deferred.close()
      await resumed.closeAll()
    }
  }
  await reopen([
    oldTurn([user(null), { type: 'agentMessage', id: 'old-answer', text: 'historical answer' }])
  ])
  expect((await journal().reads.submission('U'))?.dispatchState).toBe('unknown')
  expect(await journal().reads.receiptFor('U')).toBeNull()
  const before = journal().cursor()
  await reopen([
    oldTurn([user(null), { type: 'agentMessage', id: 'old-answer', text: 'historical answer' }])
  ])
  expect(journal().cursor()).toEqual(before)
  await journal().write({
    kind: 'epoch-replace',
    reason: 'handle_forked',
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    items: []
  })
  await reopen([
    oldTurn([
      user('U'),
      { type: 'agentMessage', id: 'previously-unseen', text: 'must stay hidden' }
    ])
  ])
  expect((await journal().reads.submission('U'))?.dispatchState).toBe('accepted')
  expect(await readTestJournalItems(journal())).toEqual([])
  await reopen([
    {
      id: 'huge',
      status: 'completed',
      items: [
        user('K'),
        ...Array.from({ length: 1_100 }, (_, n) => ({
          type: 'agentMessage',
          id: `large-${n}`,
          text: 'outside answer'
        }))
      ]
    }
  ])
  expect((await journal().reads.submission('K'))?.dispatchState).toBe('accepted')
  expect(await readTestJournalItems(journal())).toEqual([])
  expect((await journal().reads.submission('V'))?.dispatchState).toBe('unknown')
  expect(pages).not.toHaveBeenCalled()
  await reopen([])
  expect(await journal().reads.receiptFor('K')).not.toBeNull()
  expect((await journal().reads.submission('V'))?.dispatchState).toBe('unknown')
})
