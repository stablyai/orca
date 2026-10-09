// A Stop that names no turn stops what the conversation has in flight: it withdraws what is
// queued, and interrupts a handed-over message even before the provider has opened its turn —
// the gap no client can name a turn for. Against the real host, store and journal.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { CancelParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import { holdLane } from './structured-agent-session-delivery-hold.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import {
  THREAD_ID,
  acquireReadyCodexForTest,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from '../../codex/codex-structured-session-adapter-fixture'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { CodexAppServerRequestError } from '../../codex/codex-app-server-request-error'

const CALLER = { callerKey: 'client-1' }
const REFUSAL_DETAIL = { text: 'failed to interrupt turn', audience: 'person' as const }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let acknowledgeSessionRelease: Mock<
  NonNullable<StructuredAgentSessionAdapter['acknowledgeSessionRelease']>
>
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>
let events: StructuredAgentSessionEventSink | undefined
/** Set by a test whose later children are real Codex ones; the first stays the fake. */
let acquireNext:
  | ((input: StructuredAgentSessionAcquireInput) => Promise<AgentSessionAcquisition>)
  | undefined

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-conversation-stop-'))
  resetHostTestOperationIds()
  events = undefined
  acquireNext = undefined
  // Admitted, not accepted: the message is written and its turn has not opened.
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  closeSession = vi.fn(async () => true)
  setOption = vi.fn(async () => undefined)
  acknowledgeSessionRelease = vi.fn()
  log = recordingStructuredAgentSessionLogger()
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: log.logger,
    store,
    adapter: startsWhenPublished(
      {
        acquire: async (input) => {
          const { fence, spawnToken, events: sink } = input
          events = sink
          // A child started after a Stop ended the last one resumes the chat's thread.
          const resumes = (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
          const link = {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: resumes ? ('resumed' as const) : ('created' as const),
            mintedAtFence: fence,
            observedAt: NOW
          }
          if (acquireNext) {
            return { ...(await acquireNext(input)), link }
          }
          return {
            process: {
              hostId: 'local',
              pid: 4242,
              processStartTimeMs: 1_700_000_000_000,
              spawnToken
            },
            acquisitionGeneration: 'generation-1',
            link
          }
        },
        dispatch,
        closeSession,
        acknowledgeSessionRelease,
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn,
        answerPrompt: vi.fn(async () => undefined),
        setOption
      },
      () => host
    ),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** The event sink the host handed this test's child at attach. */
function hostEvents(): StructuredAgentSessionEventSink {
  if (!events) {
    throw new Error('the host attached no event sink')
  }
  return events
}

function send(text: string) {
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  const result = host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  return { id: clientOperationId, result }
}

function stop(turnId?: string, clientOperationId = hostTestOperationId()) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

function pickOption(key: string, value: string) {
  const fields = { key, value }
  return host.setOption(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

async function statusRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

/** A Stop's second step, which ends the child, runs next on the session's lane. */
function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

describe('a Stop that names no turn', () => {
  it('does not let a stalled catalog hold an option pick, steer, Stop, or replacement send', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
    codex.routes['turn/steer'] = () => ({ turn: { id: 'turn-1' } })
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 1,
      spawnToken: 'spawn-catalog',
      options: { fastMode: 'true' },
      // Codex's turn events reach the host's journal, as the runtime wires them.
      events: hostEvents()
    })
    dispatch.mockImplementation((input) => adapter.dispatch(input))
    cancelTurn.mockImplementation((input) => adapter.cancelTurn(input))
    setOption.mockImplementation((input) => adapter.setOption(input))
    // The Stop ends this child; the replacement send starts a fresh Codex child.
    closeSession.mockImplementation((sessionId) => adapter.closeSession(sessionId))
    acquireNext = (input) => acquireReadyCodexForTest(adapter, input)

    const first = send('first send')
    await first.result
    await eventually(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'turn/start')).toBe(true)
    )
    expect(await pickOption('model', 'gpt-next')).toMatchObject({
      ok: true,
      value: { options: { model: 'gpt-next', fastMode: 'true' } }
    })
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      1
    )

    const followUp = send('follow-up')
    await followUp.result
    await eventually(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'turn/steer')).toBe(true)
    )
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    codex.connections[0].handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'interrupted' }
    })
    await eventually(() => expect(codex.connections[0].closed).toBe(true))
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-2')
    const replacement = send('replacement')
    expect(await replacement.result).toMatchObject({ ok: true })
    await eventually(() =>
      expect(
        codex.connections[1]?.calls.filter((call) => call.method === 'turn/start')
      ).toHaveLength(1)
    )
    expect(
      codex.connections[1].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'gpt-next', serviceTier: 'default' })
    pending.resolve({ data: [], nextCursor: null })
  })

  // Codex can abort a turn before it starts: it answers the interrupt, then ends the turn it never
  // started. That turn ran nothing, so it draws no turn of its own, whichever of the two is read first.
  it.each([
    ['its end follows the answer', 'after'],
    ['its end is read before the answer', 'before'],
    ['no end comes', 'none']
  ])('withdraws a send whose turn Codex never started when it takes a Stop: %s', async (_, end) => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    const ended = () =>
      codex.connections[0].handlers.onNotification?.('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: 'turn-1', status: 'interrupted' }
      })
    codex.routes['turn/interrupt'] = () => {
      if (end === 'before') {
        ended()
      } else if (end === 'after') {
        setTimeout(ended)
      }
      return {}
    }
    const adapter = adapterFor(codex, { codexHome: '/codex/home' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 1,
      spawnToken: 'spawn-unstarted',
      events: hostEvents()
    })
    dispatch.mockImplementation((input) => adapter.dispatch(input))
    cancelTurn.mockImplementation((input) => adapter.cancelTurn(input))
    closeSession.mockImplementation((sessionId) => adapter.closeSession(sessionId))
    const first = send('first send')
    await first.result
    await eventually(async () => expect((await submission(first.id))?.handedOverAt).toBeDefined())

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await laneDrained()
    await host.flushStreamedEvents(SESSION)
    expect(codex.connections[0].closed).toBe(true)

    expect(await submission(first.id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    const { items } = await host.journalSnapshot(SESSION)
    expect(items.filter((item) => item.body.kind === 'turn')).toEqual([])
    expect(await statusRows()).toEqual([])
  })

  it('keeps the record of a turn Codex never started when something of it was read', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    codex.routes['turn/interrupt'] = () => {
      const notify = codex.connections[0].handlers.onNotification
      notify?.('item/completed', {
        threadId: THREAD_ID,
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', text: 'partial' }
      })
      notify?.('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: 'turn-1', status: 'interrupted' }
      })
      return {}
    }
    const adapter = adapterFor(codex, { codexHome: '/codex/home' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 1,
      spawnToken: 'spawn-unstarted-item',
      events: hostEvents()
    })
    dispatch.mockImplementation((input) => adapter.dispatch(input))
    cancelTurn.mockImplementation((input) => adapter.cancelTurn(input))
    const first = send('first send')
    await first.result
    await eventually(async () => expect((await submission(first.id))?.handedOverAt).toBeDefined())

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await host.flushStreamedEvents(SESSION)

    const { items } = await host.journalSnapshot(SESSION)
    expect(items.filter((item) => item.body.kind === 'turn').map((item) => item.body)).toEqual([
      expect.objectContaining({ turnId: 'turn-1', state: 'interrupted' })
    ])
    // Something of it ran, so it is never taken back as unrun. Codex sends no item before a turn's
    // start, so this order only guards the record; the send's own end is not this test's.
    expect((await submission(first.id))?.dispatchState).not.toBe('rejected')
  })

  // Only an interrupted end ran nothing for certain: a failure keeps its record, which carries why.
  it('keeps the record of a turn Codex failed without starting it', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    const adapter = adapterFor(codex, { codexHome: '/codex/home' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 1,
      spawnToken: 'spawn-unstarted-failed',
      events: hostEvents()
    })
    dispatch.mockImplementation((input) => adapter.dispatch(input))
    const first = send('first send')
    await first.result
    await eventually(async () => expect((await submission(first.id))?.handedOverAt).toBeDefined())

    codex.connections[0].handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'failed', error: { message: 'model overloaded' } }
    })
    await host.flushStreamedEvents(SESSION)

    const { items } = await host.journalSnapshot(SESSION)
    expect(items.filter((item) => item.body.kind === 'turn').map((item) => item.body)).toEqual([
      expect.objectContaining({ turnId: 'turn-1' })
    ])
  })

  it('fails a turn Codex refuses for a model picked before the list, then sends again', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = (params) => {
      if (params?.model === 'gpt-missing') {
        throw new CodexAppServerRequestError(
          'turn/start',
          -32602,
          'codex app-server turn/start failed: unknown model gpt-missing',
          'unknown model gpt-missing'
        )
      }
      return answerWithOpenedTurn(codex, 'turn-ok')(params)
    }
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: 1,
      spawnToken: 'spawn-bad'
    })
    dispatch.mockImplementation((input) => adapter.dispatch(input))
    setOption.mockImplementation((input) => adapter.setOption(input))

    expect(await pickOption('model', 'gpt-missing')).toMatchObject({ ok: true })
    const refused = send('first send')
    await refused.result
    await eventually(async () =>
      expect(await submission(refused.id)).toMatchObject({
        dispatchState: 'rejected',
        reason: expect.stringContaining('unknown model gpt-missing'),
        rejection: { kind: 'providerRejected' }
      })
    )

    expect(await pickOption('model', 'gpt-live')).toMatchObject({ ok: true })
    const retried = send('second send')
    await retried.result
    await eventually(() =>
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'turn/start')
      ).toHaveLength(2)
    )
    expect(
      codex.connections[0].calls.filter((call) => call.method === 'turn/start')[1]?.params
    ).toMatchObject({ model: 'gpt-live' })
    await eventually(async () =>
      expect((await submission(retried.id))?.dispatchState).not.toBe('rejected')
    )
    pending.resolve({ data: [], nextCursor: null })
  })

  // The provider took the Stop on the turn it named and never opened it: the Stop ends the child,
  // whose end takes the send back, and the next send reaches the child that resumes the chat.
  it('delivers a newly accepted message after Stop withdraws the prior send', async () => {
    const first = send('first send')
    await first.result
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    cancelTurn.mockResolvedValueOnce({ cancelled: true, turnId: 'turn-never-opened' })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(await submission(first.id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(await statusRows()).toEqual([])
    const replacement = send('replacement send')
    expect(await replacement.result).toMatchObject({ ok: true })

    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(dispatch.mock.calls[1]![0].clientMessageId).toBe(replacement.id)
  })

  // Codex can take a Stop as the turn starts, with that turn's start still buffered when the answer
  // lands. A bound sink hands each event to the journal as it is read, so the note lands after it.
  it("writes a taken Stop's note after the turn record the provider sent before its answer", async () => {
    const first = send('first send')
    await first.result
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    cancelTurn.mockImplementationOnce(async () => {
      events?.appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: SESSION, recordId: 'turn:turn-1' },
        { kind: 'turn', turnId: 'turn-1', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return { cancelled: true, turnId: 'turn-1' }
    })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    const items = (await host.journalSnapshot(SESSION)).items
    const record = items.find((item) => item.body.kind === 'turn')
    const note = items.find((item) => isStructuredAgentSessionStopNote(item.itemId))
    expect(note?.sequence).toBeGreaterThan(record?.sequence ?? Infinity)
    expect(note?.turnScope).toEqual({ kind: 'turn', turnItemId: record?.itemId })
  })

  // Codex's own shape: the turn's start is read before the interrupt's answer, so the turn has a
  // record, which the child's end settles; the send opened it and stays as it is.
  it('ends the turn the provider opened before answering, and withdraws nothing', async () => {
    const first = send('first send')
    await first.result
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    cancelTurn.mockImplementationOnce(async () => {
      hostEvents().appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: SESSION, recordId: 'turn:turn-1' },
        { kind: 'turn', turnId: 'turn-1', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return { cancelled: true, turnId: 'turn-1' }
    })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()
    await host.flushStreamedEvents(SESSION)

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect((await submission(first.id))?.dispatchState).not.toBe('rejected')
    const turn = (await host.journalSnapshot(SESSION)).items.find(
      (item) => item.body.kind === 'turn'
    )
    expect(turn?.body).toMatchObject({ state: 'interrupted' })
    expect(await statusRows()).toEqual(['Cancellation requested.'])
  })

  // The child's end settles what the Stop took; a failed write there is reported, never the Stop's.
  it('answers the Stop when settling the send it took fails, and reports the failure', async () => {
    const first = send('first send')
    await first.result
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    // The child's end settles the send in one journal write.
    vi.spyOn(journal, 'appendLifecycleBatch').mockRejectedValueOnce(new Error('the journal threw'))
    cancelTurn.mockResolvedValueOnce({ cancelled: true, turnId: 'turn-never-opened' })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ scope: 'exit-settlement', sessionId: SESSION })
      })
    )
  })

  it('is a valid cancel, and only a plain Stop may omit the turn', () => {
    const envelope = {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: '0'.repeat(64)
    }
    expect(CancelParams.safeParse({ envelope }).success).toBe(true)
    expect(
      CancelParams.safeParse({ envelope, prompt: { itemId: 'item-1', expectedRevision: 1 } })
        .success
    ).toBe(false)
    expect(CancelParams.safeParse({ envelope, scope: 'background-tasks' }).success).toBe(false)
  })

  it('interrupts a handed-over message before its turn opens, as a cancellation', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    expect(
      (await host.journalSnapshot(SESSION)).items.some((item) => item.body.kind === 'turn')
    ).toBe(false)

    const stopped = await stop()

    expect(stopped).toEqual({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: expect.anything(),
      value: { cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
    expect(cancelTurn.mock.calls[0]![0]).not.toHaveProperty('turnId')
    expect(cancelTurn.mock.calls[0]![0]).toMatchObject({ sessionId: SESSION, fence: 1 })
    await laneDrained()
    // The child's end took the unopened send back; its own row says so, so the Stop writes none.
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(await statusRows()).toEqual([])
  })

  it('withdraws what is queued on a ready child and asks the provider for nothing more', async () => {
    // Held, the send is accepted and the Stop runs next, ahead of the handover the send asks for.
    const release = holdLane(host, SESSION)
    const { id, result } = send('hello')
    const stopped = stop()
    release()
    await result

    expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    await host.flushStreamedEvents(SESSION)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await statusRows()).toEqual([])
  })

  it('withdraws a send still on its way in, which the host takes first', async () => {
    const { id, result } = send('hello')
    const stopped = stop()

    expect(await result).toMatchObject({ ok: true })
    expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    await host.flushStreamedEvents(SESSION)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ends the child when the provider could not interrupt the message still in flight', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: { detail: { text: 'failed to interrupt turn', audience: 'person' } }
    })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    // Its turn never opened, so the child's end took the send back: no row stays to report on it.
    expect((await submission(id))?.dispatchState).toBe('rejected')
    expect(await statusRows()).toEqual([])
  })

  it('ends the child when the provider never answered the interrupt', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    // Codex answers an interrupt as the turn ends, so a turn that never ends leaves it unanswered.
    cancelTurn.mockRejectedValueOnce(new Error('codex app-server turn/interrupt exceeded 30000ms'))

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    // Its turn never opened, so the child's end took the send back: no row stays to report on it.
    expect((await submission(id))?.dispatchState).toBe('rejected')
    expect(await statusRows()).toEqual([])
  })

  // The Stop has answered by the time its child's end fails, so its note is what says so.
  it.each([
    ['refused', { cancelled: false, refusal: { detail: REFUSAL_DETAIL } }],
    ['went unanswered', new Error('codex app-server turn/interrupt exceeded 30000ms')]
  ])(
    'says the Stop is unconfirmed when the interrupt %s and the child end is unproven',
    async (_case, interrupt) => {
      const { id, result } = send('hello')
      await result
      await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
      if (interrupt instanceof Error) {
        cancelTurn.mockRejectedValueOnce(interrupt)
      } else {
        cancelTurn.mockResolvedValueOnce(interrupt)
      }
      closeSession.mockResolvedValueOnce(false)

      expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
      await laneDrained()

      expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
      expect(log.entries).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({ scope: 'chat-stop', sessionId: SESSION })
        })
      )
      expect(await statusRows()).toEqual(['Cancellation was not confirmed.'])
    }
  )

  it('counts as stopped when the child exit was proven and only a later cleanup step failed', async () => {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
    cancelTurn.mockRejectedValueOnce(new Error('codex app-server turn/interrupt exceeded 30000ms'))
    acknowledgeSessionRelease.mockImplementationOnce(() => {
      throw new Error('route release failed')
    })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    // Bookkeeping after the proven exit: reported, never the Stop's failure.
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ scope: 'exit-wind-down', sessionId: SESSION })
      })
    )
    expect((await submission(id))?.dispatchState).toBe('rejected')
    expect(await statusRows()).toEqual([])
  })

  it('stops nothing when it reuses the id of a Stop the host already ran', async () => {
    const operationId = hostTestOperationId()
    expect(await stop(undefined, operationId)).toMatchObject({ ok: true, replayed: false })
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())

    // Why the client never reuses a no-turn Stop's id: the same id is the same Stop.
    expect(await stop(undefined, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  // Claude's echo accepts the send one sink write before the row of the turn it opens.
  async function acceptedWithTurnRowUnlanded(): Promise<void> {
    dispatch.mockResolvedValueOnce({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 1 }
    })
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
  }

  it('interrupts a turn whose accepted send is in the journal before its row lands', async () => {
    await acceptedWithTurnRowUnlanded()
    // Emitted as the Stop arrives: the Stop's read takes its place behind it in the journal.
    events!.appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: SESSION, recordId: 'turn-lifecycle:turn-2' },
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-2', state: 'running' }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(await statusRows()).toContain('Cancellation requested.')
  })

  it('is a quiet no-op with nothing in flight', async () => {
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(await statusRows()).toEqual([])
  })
})

describe('a Stop that names its turn, as an older client sends it', () => {
  it('reaches the provider with that turn, and writes no row when it stopped nothing', async () => {
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stop('turn-1')).toMatchObject({
      ok: true,
      value: { turnId: 'turn-1', cancelled: false }
    })
    expect(cancelTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-1' }))
    expect(await statusRows()).toEqual([])
  })

  it('keeps the child, and writes no row, when the provider could not interrupt it with the conversation at rest', async () => {
    cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: { detail: { text: 'failed to interrupt turn', audience: 'person' } }
    })

    expect(await stop('turn-1')).toMatchObject({ ok: true, value: { cancelled: false } })

    expect(closeSession).not.toHaveBeenCalled()
    expect(await statusRows()).toEqual([])
  })

  /** A send queued on the host and not yet handed over: the lane is held until `release`, so a
   *  step asked for before it runs ahead of the handover. */
  function queueOnHost(): { id: string; release: () => void } {
    const release = holdLane(host, SESSION)
    return { id: send('hello').id, release }
  }

  it('reports success with no row when it withdrew a queued message and the turn had ended', async () => {
    const queued = queueOnHost()
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    const stopped = stop('turn-1')
    queued.release()
    expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await submission(queued.id)).toMatchObject({ dispatchState: 'rejected' })
    expect(await statusRows()).toEqual([])
  })

  // Codex refuses an interrupt for a turn that has ended.
  it('reports success with no row when the provider refused a turn that had ended', async () => {
    const queued = queueOnHost()
    cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: { detail: { text: 'no such turn', audience: 'person' } }
    })

    const stopped = stop('turn-1')
    queued.release()
    expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await submission(queued.id)).toMatchObject({ dispatchState: 'rejected' })
    expect(await statusRows()).toEqual([])
  })
})

describe('a Stop ends the agent session', () => {
  async function handedOver(): Promise<void> {
    const { id, result } = send('hello')
    await result
    await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
  }

  /** The handed-over send's turn opened, so the child's end takes nothing back. */
  async function turnRunning(): Promise<void> {
    await handedOver()
    hostEvents().appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: SESSION, recordId: 'turn:turn-1' },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
  }

  it('ends the child after a Stop the provider took', async () => {
    await handedOver()
    cancelTurn.mockResolvedValueOnce({ cancelled: true })

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    // The Stop answers first; its next step on the session's lane ends the child.
    await laneDrained()

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  // Whatever the provider said of the interrupt, the child's end is what stops the work.
  it.each([
    ['refused it', { cancelled: false, refusal: { detail: REFUSAL_DETAIL } }],
    [
      'refused it as no turn running',
      { cancelled: false, refusal: { detail: REFUSAL_DETAIL, turnNotRunning: true as const } }
    ],
    ['said it had no turn', { cancelled: false }]
  ])(
    'ends the child after the cancel even when the provider %s, and says only that it was asked',
    async (_case, answer) => {
      await turnRunning()
      cancelTurn.mockResolvedValueOnce(answer)

      expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
      await laneDrained()

      expect(closeSession).toHaveBeenCalledWith(SESSION)
      expect(await statusRows()).toEqual(['Cancellation requested.'])
    }
  )

  it('ends the child and says it was asked when the provider declined a Stop naming the live turn', async () => {
    await turnRunning()
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    // Ending the session stops the turn, so this Stop stopped something and writes its one note.
    expect(await stop('turn-1')).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(await statusRows()).toEqual(['Cancellation requested.'])
  })

  it('leaves the child alone when the Stop named a turn that is no longer live', async () => {
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stop('turn-1')).toMatchObject({ ok: true, value: { cancelled: false } })
    await laneDrained()

    expect(closeSession).not.toHaveBeenCalled()
    // It stopped nothing, so it writes no row.
    expect(await statusRows()).toEqual([])
  })

  it("ends the child when the provider's cancel of a Stop naming a turn no longer live fails", async () => {
    await handedOver()
    // The interrupt went out and its answer was lost: what it stopped is unknown.
    cancelTurn.mockRejectedValueOnce(new Error('control request lost'))

    expect(await stop('turn-1')).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(await statusRows()).toEqual(['Cancellation requested.'])
  })

  it('ends the child when the provider took a Stop naming a turn that is no longer live', async () => {
    await handedOver()
    // The interrupt stopped the follow-up in flight, which has no turn a client could name.
    cancelTurn.mockResolvedValueOnce({ cancelled: true })

    expect(await stop('turn-1')).toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(await statusRows()).toEqual(['Cancellation requested.'])
  })
})
