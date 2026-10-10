import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  CREATE_TEST_CALLER as CALLER,
  createTestParams,
  stopCreatedChat
} from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { AgentSessionPreSpawnError } from './structured-agent-session-adapter'
import {
  openTestJournalHostDatabase,
  loadTestJournal
} from '../agent-session-journal/journal-host-database-test-support'
import { readPersistedTestAgentSessionStore } from '../../runtime/agent-session-record-store-test-harness'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../../shared/native-chat-stopped-before-start'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  await rig.dispose()
  vi.restoreAllMocks()
})

function firstMessage() {
  return { clientMessageId: hostTestOperationId(), body: hostTestMessage('opening message') }
}

function abortableAcquisition() {
  const entered = Promise.withResolvers<void>()
  rig.adapter.acquire.mockImplementationOnce(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        entered.resolve()
        const abort = () => reject(new AgentSessionPreSpawnError(signal?.reason))
        if (signal?.aborted) {
          abort()
        } else {
          signal?.addEventListener('abort', abort, { once: true })
        }
      })
  )
  return entered.promise
}

it('commits the record, tab, operation and first message together and returns while acquire is unresolved', async () => {
  const first = firstMessage()
  const params = createTestParams(first, { surfaceTabId: 'chat-create-tab' })
  const entered = abortableAcquisition()
  const observed: unknown[] = []
  rig.store.onFirstRecord(() =>
    observed.push({
      record: rig.store.getRecord(SESSION),
      tab: rig.store.getSessionTabId(SESSION),
      operation: rig.store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId),
      submission: loadTestJournal(rig.root, SESSION)?.state.submissions.get(first.clientMessageId)
    })
  )
  const publishTab = vi.fn(async () => {
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null
    })
  })
  const result = await rig.host.create(CALLER, params, { firstMessage: first, publishTab })
  expect(result).toMatchObject({
    ok: true,
    fence: 1,
    value: {
      tabId: 'chat-create-tab',
      firstMessage: { clientMessageId: first.clientMessageId, dispatchState: 'pending' },
      page: {
        submissions: [{ clientMessageId: first.clientMessageId, dispatchState: 'pending' }],
        items: expect.arrayContaining([expect.objectContaining({ body: first.body })])
      }
    }
  })
  expect(observed).toMatchObject([
    {
      tab: 'chat-create-tab',
      operation: { outcome: { status: 'succeeded' } },
      submission: { clientMessageId: first.clientMessageId },
      record: { lease: { claimStatus: 'released' } }
    }
  ])
  expect(publishTab).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
  await entered
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  expect(await stopCreatedChat(rig.host)).toMatchObject({ ok: true, value: { cancelled: true } })
})

it('creates a blank chat at rest without acquiring and persists its launch arguments', async () => {
  const resolveLaunchArgs = vi.fn(() => ['--test-flag'])
  const resolveLaunchEnv = vi.fn(() => ({ SAFE_FLAG: 'yes' }))
  await rig.dispose()
  rig = await createRestTestRig({
    resolveLaunchArgs,
    resolveLaunchEnv,
    idleSweep: { intervalMs: 60_000 }
  })
  expect(await rig.host.create(CALLER, createTestParams())).toMatchObject({
    ok: true,
    value: { page: { submissions: [] } }
  })
  expect(rig.store.getRecord(SESSION)).toMatchObject({
    launchArgs: ['--test-flag'],
    lease: {
      claimStatus: 'released',
      runtimeFence: 1,
      ownerProcess: null,
      reservedSpawnToken: null
    }
  })
  expect(resolveLaunchEnv).toHaveBeenCalledOnce()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('keeps delivery behind runtime tab publication even after the message is committed', async () => {
  const first = firstMessage()
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const entered = abortableAcquisition()
  let answered = false
  const creating = rig.host
    .create(CALLER, createTestParams(first), {
      firstMessage: first,
      publishTab: async () => {
        held.resolve()
        await release.promise
      }
    })
    .then((result) => {
      answered = true
      return result
    })
  await held.promise
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rig.store.getRecord(SESSION)).not.toBeNull()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(answered).toBe(false)
  release.resolve()
  expect(await creating).toMatchObject({ ok: true })
  await entered
  await stopCreatedChat(rig.host)
})

it('an immediate Stop cancels the queued first message before acquire and replay never redelivers it', async () => {
  const first = firstMessage()
  const params = createTestParams(first)
  let stopping: ReturnType<typeof stopCreatedChat> | undefined
  expect(
    await rig.host.create(CALLER, params, {
      firstMessage: first,
      publishTab: async () => {
        stopping = stopCreatedChat(rig.host)
      }
    })
  ).toMatchObject({ ok: true })
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(await rig.host.create(CALLER, params, { firstMessage: first })).toMatchObject({
    ok: true,
    replayed: true,
    value: {
      page: {
        submissions: [{ clientMessageId: first.clientMessageId, rejection: { kind: 'cancelled' } }]
      }
    }
  })
  expect(
    rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.stopMarks.latest()
  ).toMatchObject({ event: { reason: 'user-stop' } })
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it('holds the created first message until the child proves its start, then hands it over once', async () => {
  const first = firstMessage()
  const spawn = rig.adapter.acquire.getMockImplementation()!
  let generation = ''
  rig.adapter.acquire.mockImplementationOnce(async (input) => {
    const child = await spawn(input)
    generation = child.acquisitionGeneration ?? ''
    return { ...child, providerChildPhase: 'starting' as const }
  })
  expect(
    await rig.host.create(CALLER, createTestParams(first), { firstMessage: first })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  const held = (await rig.host.journalSnapshot(SESSION)).submissions
  expect(held).toEqual([expect.objectContaining({ clientMessageId: first.clientMessageId })])
  expect(held[0].handedOverAt).toBeUndefined()

  await rig.host.handleAdapterEvent({
    type: 'started',
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: generation,
    reportedOptions: { model: 'gpt-live' },
    restoreSkippedOptions: [],
    optionRevision: rig.host.collaboratorsForTests().runtimeState.optionRevisions.current(SESSION)
  })

  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.dispatch).toHaveBeenCalledWith(expect.objectContaining({ body: first.body }))
  expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rig.adapter.dispatch).toHaveBeenCalledOnce()
})

it('Stop while the child proves its start withdraws the created first message once, unsent', async () => {
  const first = firstMessage()
  const spawn = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementationOnce(async (input) => ({
    ...(await spawn(input)),
    providerChildPhase: 'starting' as const
  }))
  expect(
    await rig.host.create(CALLER, createTestParams(first), { firstMessage: first })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())

  expect(await stopCreatedChat(rig.host)).toMatchObject({ ok: true, value: { cancelled: true } })

  const submissions = (await rig.host.journalSnapshot(SESSION)).submissions
  expect(submissions).toEqual([
    expect.objectContaining({
      clientMessageId: first.clientMessageId,
      dispatchState: 'rejected',
      rejection: expect.objectContaining({ kind: 'cancelled' })
    })
  ])
  expect(submissions[0].handedOverAt).toBeUndefined()
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it('Stop aborts a handshake outside the lane and the next send sends only its own text', async () => {
  const first = firstMessage()
  const params = createTestParams(first)
  const entered = abortableAcquisition()
  expect(await rig.host.create(CALLER, params, { firstMessage: first })).toMatchObject({ ok: true })
  await entered
  expect(await stopCreatedChat(rig.host)).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await rig.host.create(CALLER, params, { firstMessage: first })).toMatchObject({
    ok: true,
    replayed: true
  })
  const next = restTestSend('next message', rig.store.getRecord(SESSION)?.lease.runtimeFence)
  expect(await rig.host.send(CALLER, next)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.dispatch).toHaveBeenCalledWith(expect.objectContaining({ body: next.body }))
  const snapshot = await rig.host.journalSnapshot(SESSION)
  expect(snapshot.submissions).toHaveLength(2)
  expect(
    snapshot.submissions.find(({ clientMessageId }) => clientMessageId === first.clientMessageId)
      ?.rejection
  ).toMatchObject({ kind: 'cancelled' })
})

it('replays the stopped first message even after its row falls outside the hydration page', async () => {
  const first = firstMessage()
  const params = createTestParams(first)
  let stopping: ReturnType<typeof stopCreatedChat> | undefined
  expect(
    await rig.host.create(CALLER, params, {
      firstMessage: first,
      publishTab: async () => {
        stopping = stopCreatedChat(rig.host)
      }
    })
  ).toMatchObject({ ok: true })
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('created chat has no journal')
  }
  for (let ordinal = 1; ordinal <= AGENT_SESSION_HISTORY_MAX_LIMIT + 1; ordinal += 1) {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'later-history', ordinal },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `later ${ordinal}` }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  const append = vi.spyOn(journal, 'appendSubmission')
  const replay = await rig.host.create(CALLER, params, { firstMessage: first })
  if (!replay.ok) {
    throw new Error(`create replay refused: ${replay.refusal.code}`)
  }
  expect(replay.replayed).toBe(true)
  expect(replay.value.page.hasOlder).toBe(true)
  expect(replay.value.page.items).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ body: first.body })])
  )
  expect(replay.value.page.submissions).toEqual([])
  expect(replay.value.firstMessage).toMatchObject({
    clientMessageId: first.clientMessageId,
    dispatchState: 'rejected',
    rejection: { kind: 'cancelled' }
  })
  expect(append).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it('admits Stop with the create-returned fence after acquisition advances it and keeps the stopped row', async () => {
  const first = firstMessage()
  const entered = abortableAcquisition()
  const created = await rig.host.create(CALLER, createTestParams(first), { firstMessage: first })
  if (!created.ok) {
    throw new Error(`create refused: ${created.refusal.code}`)
  }
  expect(created.fence).toBe(1)
  await entered
  expect(rig.store.getRecord(SESSION)?.lease.runtimeFence).toBeGreaterThan(created.fence)
  const stopping = stopCreatedChat(rig.host, SESSION, created.fence)
  let stopped: Awaited<typeof stopping> | undefined
  void stopping.then((outcome) => {
    stopped = outcome
  })
  try {
    await vi.waitFor(() => expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } }))
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.submissions).toMatchObject([
      {
        clientMessageId: first.clientMessageId,
        dispatchState: 'rejected',
        rejection: { kind: 'cancelled' }
      }
    ])
    expect(
      projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions, {
        rejectedInPlace: true
      })
    ).toMatchObject([
      { role: 'user', blocks: first.body.blocks },
      { blocks: [{ type: 'text', text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT }] }
    ])
    expect(
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.stopMarks.latest()
    ).toMatchObject({ event: { reason: 'user-stop' } })
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  } finally {
    rig.host.collaboratorsForTests().runtimeState.acquireAborts.abort(SESSION, 'test cleanup')
    await stopping
  }
})

it.each(['journal_rows', 'agent_session_operations'])(
  'rolls back all create state when %s refuses its write',
  async (table) => {
    const first = firstMessage()
    const params = createTestParams(first)
    const db = openTestJournalHostDatabase(rig.root).db
    const when = table === 'journal_rows' ? `WHEN NEW.row_json LIKE '%"kind":"submission"%'` : ''
    db.exec(
      `CREATE TRIGGER refuse_create BEFORE INSERT ON ${table} ${when} BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`
    )
    const publishTab = vi.fn(async () => {})
    expect(
      await rig.host.create(CALLER, params, { firstMessage: first, publishTab })
    ).toMatchObject({ ok: false })
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(rig.store.getSessionTabId(SESSION)).toBeNull()
    expect(rig.store.listOperationRows()).toEqual([])
    expect((await readPersistedTestAgentSessionStore(rig.root)).records).toEqual({})
    expect(loadTestJournal(rig.root, SESSION)?.state.submissions.size).toBe(0)
    expect(rig.host.hasSession(SESSION)).toBe(false)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(publishTab).not.toHaveBeenCalled()
    db.exec('DROP TRIGGER refuse_create')
    const entered = abortableAcquisition()
    expect(
      await rig.host.create(CALLER, params, { firstMessage: first, publishTab })
    ).toMatchObject({ ok: true })
    await entered
    await stopCreatedChat(rig.host)
  }
)

it('answers a journal founding failure as a refusal before publishing any create state', async () => {
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(
    `CREATE TRIGGER refuse_epoch BEFORE INSERT ON journal_rows WHEN NEW.row_json LIKE '%"kind":"epoch"%' BEGIN SELECT RAISE(ABORT, 'simulated journal open failure'); END`
  )
  const first = firstMessage()
  expect(
    await rig.host.create(CALLER, createTestParams(first), { firstMessage: first })
  ).toMatchObject({ ok: false, refusal: { code: 'agent_session_journal_unreadable' } })
  expect(rig.store.listRecords()).toEqual([])
  expect(rig.store.listOperationRows()).toEqual([])
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('retries tab publication from the committed message without acquiring early or appending again', async () => {
  const first = firstMessage()
  const params = createTestParams(first)
  expect(
    await rig.host.create(CALLER, params, {
      firstMessage: first,
      publishTab: async () => {
        throw new Error('tab unavailable')
      }
    })
  ).toMatchObject({ ok: false, refusal: { details: { reason: 'tabUnconfirmed' } } })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  const append = vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission')
  const entered = abortableAcquisition()
  expect(await rig.host.create(CALLER, params, { firstMessage: first })).toMatchObject({
    ok: true,
    replayed: true
  })
  expect(append).not.toHaveBeenCalled()
  await entered
  await stopCreatedChat(rig.host)
})
