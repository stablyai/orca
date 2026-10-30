import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  agentSessionMessagePayload,
  agentSessionSendBodyFingerprint
} from '../../../shared/structured-agent-session-send-mutation'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  CREATE_TEST_CALLER,
  createTestParams
} from './structured-agent-session-create-test-fixture'
import {
  acceptedDispatch,
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS,
  REST_TEST_CALLER,
  restTestSend
} from './structured-agent-session-rest-test-rig'

const PICKED = { model: 'gpt-picked', effort: 'high' }

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

describe('a send carrying its model and effort to a chat at rest', () => {
  it('records them before the start its message needs, so the agent starts on them', async () => {
    const rest = await createRestTestRig()
    try {
      await foundRestTestChat(rest)
      rest.clock.now += IDLE_MS + 1
      await vi.waitFor(() =>
        expect(rest.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      )
      const send = restTestSend('carry on', rest.store.getRecord(SESSION)?.lease.runtimeFence)
      const fields = { body: send.body, options: PICKED }
      const sent = await rest.host.send(REST_TEST_CALLER, {
        ...send,
        envelope: {
          ...send.envelope,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields
          })
        },
        options: PICKED
      })
      expect(sent.ok).toBe(true)
      await vi.waitFor(() => expect(rest.adapter.acquire).toHaveBeenCalledTimes(2))
      expect(rest.adapter.acquire).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining(PICKED) })
      )
    } finally {
      await rest.dispose()
    }
  })
})

describe('an opening message created with a model and effort', () => {
  const OPENED = { model: 'opus', effort: 'high' }

  async function createWhileStarting(
    rest: Awaited<ReturnType<typeof createRestTestRig>>,
    options: Record<string, string> = OPENED
  ) {
    const start = rest.adapter.acquire.getMockImplementation()!
    rest.adapter.acquire.mockImplementationOnce(rest.heldStart(start))
    const first = { clientMessageId: hostTestOperationId(), body: hostTestMessage('opening') }
    const params = createTestParams(first, { options })
    expect(
      await rest.host.create(CREATE_TEST_CALLER, params, { firstMessage: first })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(rest.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
    )
    const proveStart = async () =>
      rest.proveStart({
        sessionId: SESSION,
        fence: rest.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: (await rest.adapter.acquire.mock.results[0]!.value)
          .acquisitionGeneration
      })
    return { first, proveStart }
  }

  it('runs on them though a pick made before its handover changed the chat', async () => {
    const rest = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    try {
      // Limit to model: this rig’s pick response replaces rather than merges saved options.
      const { proveStart } = await createWhileStarting(rest, { model: 'opus' })
      const fields = { key: 'model', value: 'sonnet' }
      const send = restTestSend('unused', rest.store.getRecord(SESSION)?.lease.runtimeFence)
      const envelope = {
        ...send.envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields
        })
      }
      const picked = rest.host.setOption(REST_TEST_CALLER, { envelope, ...fields })
      rest.adapter.dispatch.mockImplementationOnce(async () => acceptedDispatch())
      await proveStart()
      await vi.waitFor(() => expect(rest.adapter.dispatch).toHaveBeenCalledOnce())
      expect(rest.adapter.dispatch.mock.calls[0]?.[0].executionOptions).toEqual({ model: 'opus' })
      expect(await picked).toMatchObject({ ok: true })
      expect(rest.store.getRecord(SESSION)?.options?.model).toBe('sonnet')
    } finally {
      await rest.dispose()
    }
  })

  it('keeps them on the card Orca keeps when it stops before the handover', async () => {
    const rest = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    try {
      const { first } = await createWhileStarting(rest)
      const host = await rest.restart()
      expect(await host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
        ok: true
      })
      const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
      expect(journal?.queuedMessages.list()).toMatchObject([
        { messageId: first.clientMessageId, options: OPENED }
      ])
    } finally {
      await rest.dispose()
    }
  })
})

const openingSelections: (Readonly<Record<string, string>> | undefined)[] = [
  undefined,
  {},
  { model: 'shown-model', effort: 'high', serviceTier: 'default' }
]

it.each(openingSelections)(
  'aliases the real opening echo by body and replays the immutable create selection %j',
  async (selection) => {
    const rest = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    try {
      const accepted = Promise.withResolvers<ReturnType<typeof acceptedDispatch>>()
      rest.adapter.dispatch.mockImplementationOnce(() => accepted.promise)
      const saved = { model: 'saved-model', effort: 'low', personality: 'friendly' }
      const first: StructuredAgentSessionFirstMessage = {
        clientMessageId: hostTestOperationId(),
        body: hostTestMessage('opening echo'),
        ...(selection !== undefined ? { selection } : {})
      }
      const params = createTestParams(first, { options: saved })
      const envelope = structuredClone(params.envelope)
      const created = await rest.host.create(CREATE_TEST_CALLER, params, { firstMessage: first })
      expect(created.ok).toBe(true)
      await vi.waitFor(() => expect(rest.adapter.dispatch).toHaveBeenCalledOnce())
      const expected = selection === undefined ? saved : { personality: 'friendly', ...selection }
      expect(rest.adapter.dispatch.mock.calls[0][0].executionOptions).toEqual(expected)
      const events = rest.adapter.acquire.mock.calls[0][0].events!
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'root-turn', ordinal: 2 },
        first.body,
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await rest.host.flushStreamedEvents(SESSION)
      accepted.resolve({
        state: 'accepted',
        providerIdentity: {
          provider: 'codex',
          threadId: THREAD,
          turnId: 'predicted-turn',
          ordinal: 0
        }
      })
      await vi.waitFor(async () =>
        expect((await rest.host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe(
          'accepted'
        )
      )
      const snapshot = await rest.host.journalSnapshot(SESSION)
      expect(
        snapshot.items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
      ).toHaveLength(1)
      expect(snapshot.submissions).toMatchObject([
        {
          clientMessageId: first.clientMessageId,
          payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, first.body),
          options: expected
        }
      ])
      await rest.store.replaceSessionOptions({
        sessionId: SESSION,
        fence: rest.store.getRecord(SESSION)!.lease.runtimeFence,
        now: HOST_TEST_NOW,
        options: { model: 'new-default', effort: 'medium', personality: 'changed' }
      })
      const changedFirst: StructuredAgentSessionFirstMessage = {
        ...first,
        selection: selection?.model ? {} : { model: 'changed-control' }
      }
      const changedParams = createTestParams(changedFirst, { options: saved })
      expect(changedParams.envelope.payloadFingerprint).not.toBe(envelope.payloadFingerprint)
      const conflict = await rest.host.create(
        CREATE_TEST_CALLER,
        {
          ...changedParams,
          envelope: { ...envelope, payloadFingerprint: changedParams.envelope.payloadFingerprint }
        },
        { firstMessage: changedFirst }
      )
      expect(conflict).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_operation_conflict' }
      })
      const replay = await rest.host.create(CREATE_TEST_CALLER, params, { firstMessage: first })
      expect(replay).toMatchObject({
        ok: true,
        replayed: true,
        value: {
          firstMessage: {
            clientMessageId: first.clientMessageId,
            payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, first.body),
            options: expected
          }
        }
      })
      expect(params.envelope).toEqual(envelope)
      expect(first.selection).toEqual(selection)
      expect((await rest.host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
      expect(rest.adapter.dispatch).toHaveBeenCalledOnce()
      expect(rest.adapter.dispatch.mock.calls[0][0].executionOptions).toEqual(expected)
    } finally {
      await rest.dispose()
    }
  }
)

describe('a send carrying its model and effort', () => {
  it('fingerprints them with the operation, so the same id with other options conflicts', async () => {
    const body = hostTestMessage('once')
    const clientOperationId = hostTestOperationId()
    const params = (options: Record<string, string>) => {
      const fields = { body: agentSessionMessagePayload(body), options }
      return {
        envelope: rig.envelope(fields, 'agentSession.send', clientOperationId),
        ...fields,
        body
      }
    }
    expect(await rig.host.send(CALLER, params(PICKED))).toMatchObject({ ok: true })
    expect(await rig.host.send(CALLER, params({ model: 'other' }))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_conflict' }
    })
  })
})

describe('a send kept as a card because Orca stopped before handing it over', () => {
  it('keeps its model and effort on the card', async () => {
    const kept = await createQueuedMessageTestRig({ restartable: true })
    try {
      await kept.host.close(SESSION, 'evict')
      const startsBefore = kept.starts.mock.calls.length
      kept.holdNextStart()
      const sent = kept.send('picked', undefined, { carried: PICKED })
      expect(await sent.result).toMatchObject({ ok: true })
      await eventually(() => expect(kept.starts.mock.calls.length).toBeGreaterThan(startsBefore))
      await kept.crashRestartHostProcess()
      expect(await kept.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
      const journal = kept.host.collaboratorsForTests().sessions.get(SESSION)?.journal
      expect(journal?.queuedMessages.list()).toMatchObject([
        { messageId: sent.id, options: PICKED }
      ])
    } finally {
      await kept.dispose()
    }
  })
})

it('captures the shown tuple despite unseen saved picks, preserves personality, and distinguishes empty exact from legacy capture', async () => {
  const saved = {
    model: 'hidden-model',
    effort: 'low',
    serviceTier: 'priority',
    personality: 'friendly'
  }
  await rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: 1,
    now: HOST_TEST_NOW,
    options: saved
  })
  const send = (selection?: Record<string, string>, delivery?: 'queue-if-active') => {
    const body = hostTestMessage('shown selection')
    const fields = {
      body,
      ...(selection !== undefined ? { selection } : {}),
      ...(delivery ? { delivery } : {})
    }
    const params = {
      ...fields,
      envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId())
    }
    return { params, result: rig.host.send(CALLER, params) }
  }
  const shown = { model: 'shown-model', effort: 'high', serviceTier: 'default' }
  const exact = send(shown)
  expect(await exact.result).toMatchObject({
    ok: true,
    value: { submission: { options: { ...shown, personality: 'friendly' } } }
  })
  expect(rig.store.getRecord(SESSION)?.options).toEqual(saved)
  const empty = send({})
  expect(await empty.result).toMatchObject({
    ok: true,
    value: { submission: { options: { personality: 'friendly' } } }
  })
  expect((await rig.submission(empty.params.envelope.clientOperationId))?.options).toEqual({
    personality: 'friendly'
  })
  expect(await send().result).toMatchObject({ ok: true, value: { submission: { options: saved } } })
  const changed = {
    ...exact.params,
    selection: {},
    envelope: {
      ...exact.params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body: exact.params.body, selection: {} }
      })
    }
  }
  expect(await rig.host.send(CALLER, changed)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_conflict' }
  })
})
