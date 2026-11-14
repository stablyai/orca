import { CodexAppServerTimeoutError } from '../../../../codex/app-server/codex-app-server-session'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { createDeferredStructuredAgentSessionEventSink } from '../../journal-ingress/structured-agent-session-event-sink'
import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
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
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { CodexStructuredSessionAdapter } from '../../../../codex/structured/session-lifecycle/codex-structured-session-adapter'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  hostTestSendParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from '../../providers/testing/structured-agent-session-adapter-router-test-support'

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
    journalDatabase: openTestJournalHostDatabase(root),
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
  await journal().replaceEpochItems('handle_forked', store.getRecord(SESSION)!.lease.runtimeFence, [
    { identity: { provider: 'orca', clientMessageId: 'U' }, body, ownerFence: 1 }
  ])
  expect(journal().item('orca:U')?.revision).toBeGreaterThan(1)
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
    await host.journalSnapshot(SESSION)
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
  expect(journal().submission('U')?.dispatchState).toBe('unknown')
  expect(journal().receiptFor('U')).toBeNull()
  const before = journal().cursor()
  await reopen([
    oldTurn([user(null), { type: 'agentMessage', id: 'old-answer', text: 'historical answer' }])
  ])
  expect(journal().cursor()).toEqual(before)
  await journal().replaceEpochItems(
    'handle_forked',
    store.getRecord(SESSION)!.lease.runtimeFence,
    []
  )
  await reopen([
    oldTurn([
      user('U'),
      { type: 'agentMessage', id: 'previously-unseen', text: 'must stay hidden' }
    ])
  ])
  expect(journal().submission('U')?.dispatchState).toBe('accepted')
  expect(journal().snapshot().items).toEqual([])
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
  expect(journal().submission('K')?.dispatchState).toBe('accepted')
  expect(journal().snapshot().items).toEqual([])
  expect(journal().submission('V')?.dispatchState).toBe('unknown')
  expect(pages).not.toHaveBeenCalled()
  await reopen([])
  expect(journal().receiptFor('K')).not.toBeNull()
  expect(journal().submission('V')?.dispatchState).toBe('unknown')
})

it('settles a settings timeout before review as refused and admits the next normal send', async () => {
  await host.setSessionTabVisibility(SESSION, true)
  const envelope = (method: string, fields: Record<string, unknown>) => ({
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  })
  const option = { key: 'model', value: 'gpt-review' }
  expect(
    await host.setOption(CALLER, {
      ...option,
      envelope: envelope('agentSession.setOption', option)
    })
  ).toMatchObject({ ok: true })
  codex.routes['thread/settings/update'] = () => {
    throw new CodexAppServerTimeoutError('settings timed out')
  }
  const fields = {
    command: 'review' as const,
    review: { type: 'custom' as const },
    instructions: 'check correctness'
  }
  const params = { ...fields, envelope: envelope('agentSession.conversationCommand', fields) }
  const result = await host.conversationCommand(CALLER, params)
  expect(result).toMatchObject({ ok: true })
  await vi.waitFor(async () => {
    const settled = await host.journalSnapshot(SESSION)
    expect(
      settled.submissions.find(
        ({ clientMessageId }) => clientMessageId === params.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'rejected' })
  })
  expect(
    codex.connections
      .flatMap(({ calls }) => calls)
      .filter(({ method }) => method === 'review/start')
  ).toEqual([])
  const snapshot = await host.journalSnapshot(SESSION)
  expect(
    snapshot.submissions.find(
      ({ clientMessageId }) => clientMessageId === params.envelope.clientOperationId
    )
  ).toMatchObject({ dispatchState: 'rejected' })
  expect(
    snapshot.items.map(({ body }) => readAgentJournalTurn(body)).filter(Boolean)
  ).toContainEqual(expect.objectContaining({ state: 'completed', outcome: 'failure' }))
  const send = hostTestSendParams('hello')
  send.envelope.expectedRuntimeFence = store.getRecord(SESSION)!.lease.runtimeFence
  codex.routes['turn/start'] = () => {
    const notify = codex.connections.at(-1)!.handlers.onNotification!
    notify('turn/started', {
      threadId: THREAD,
      turn: { id: 'normal-after-settings', rootTurnId: null }
    })
    notify('item/completed', {
      threadId: THREAD,
      turnId: 'normal-after-settings',
      item: {
        id: 'normal-echo',
        type: 'userMessage',
        clientId: send.envelope.clientOperationId,
        content: [{ type: 'text', text: 'hello', text_elements: [] }]
      }
    })
    return { turn: { id: 'normal-after-settings' } }
  }
  expect(await host.send(CALLER, send)).toMatchObject({ ok: true })
  await vi.waitFor(async () => {
    const after = await host.journalSnapshot(SESSION)
    expect(
      after.submissions.find(
        ({ clientMessageId }) => clientMessageId === send.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'accepted' })
    expect(
      after.items.map(({ body }) => readAgentJournalTurn(body)).filter(Boolean)
    ).toContainEqual(expect.objectContaining({ turnId: 'normal-after-settings', state: 'running' }))
  })
})
