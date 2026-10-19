// A send's carried model and effort against the real host, store and journal: kept with the
// message and applied as it is handed over (recorded before a start, written to a running child),
// skipped when the chat already holds it, never stopping the message, part of the operation's
// fingerprint, and kept on a queued card until the card goes out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionMessagePayload } from '../../../shared/structured-agent-session-send-mutation'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
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

function recordedOptions(): Readonly<Record<string, string>> | undefined {
  return rig.store.getRecord(SESSION)?.options
}

async function handedOver(id: string): Promise<void> {
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
}

/** A running child with nothing in flight. */
async function idleRunningChild(): Promise<void> {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'idle')
}

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

  /** Creates the chat with its opening message; its agent stays starting until `proveStart`. */
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
      rest.host.handleAdapterEvent({
        type: 'started',
        sessionId: SESSION,
        fence: rest.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: (await rest.adapter.acquire.mock.results[0]!.value)
          .acquisitionGeneration,
        reportedOptions: options
      })
    return { first, proveStart }
  }

  it('runs on them though a pick made before its handover changed the chat', async () => {
    const rest = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    try {
      // Model only: this rig's agent answers a pick with nothing, so each write replaces the record.
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
      const ranOn: (string | undefined)[] = []
      rest.adapter.dispatch.mockImplementationOnce(async () => {
        ranOn.push(rest.store.getRecord(SESSION)?.options?.model)
        return acceptedDispatch()
      })
      await proveStart()
      await vi.waitFor(() => expect(rest.adapter.dispatch).toHaveBeenCalledOnce())
      expect(ranOn).toEqual(['opus'])
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

describe('a send carrying its model and effort', () => {
  it('writes them to a running child as it is handed over, model first, skipping what the chat holds', async () => {
    await idleRunningChild()
    const first = rig.send('switch', undefined, { carried: PICKED })
    await first.result
    await handedOver(first.id)
    expect(vi.mocked(rig.setOption).mock.calls.map(([input]) => input.key)).toEqual([
      'model',
      'effort'
    ])
    expect(recordedOptions()).toMatchObject({ effort: 'high' })
    await rig.settleAccepted(first.id, 'switch')

    vi.mocked(rig.setOption).mockClear()
    const again = rig.send('same again', undefined, { carried: { effort: 'high' } })
    await again.result
    await handedOver(again.id)
    expect(rig.setOption).not.toHaveBeenCalled()
  })

  it("runs an accepted message on its own selection, though a later pick changed the chat's", async () => {
    const starting = await createQueuedMessageTestRig({ starting: true })
    try {
      const sent = starting.send('mine', undefined, { carried: { model: 'gpt-a' } })
      expect(await sent.result).toMatchObject({ ok: true })
      await eventually(() => expect(starting.starts).toHaveBeenCalled())
      // Picked while the message waits for its agent to start.
      const fields = { key: 'model', value: 'gpt-b' }
      const picked = starting.host.setOption(CALLER, {
        envelope: starting.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
        ...fields
      })
      const setOption = vi.mocked(starting.setOption)
      starting.dispatch.mockImplementationOnce(async () => {
        expect(setOption.mock.calls.at(-1)?.[0]).toMatchObject({ key: 'model', value: 'gpt-a' })
        expect(setOption.mock.invocationCallOrder.at(-1)).toBeLessThan(
          starting.dispatch.mock.invocationCallOrder.at(-1) ?? 0
        )
        return acceptedDispatch()
      })
      await starting.proveStart()
      await eventually(async () =>
        expect((await starting.submission(sent.id))?.handedOverAt).toBeDefined()
      )
      expect(await picked).toMatchObject({ ok: true })
      expect(starting.store.getRecord(SESSION)?.options?.model).toBe('gpt-b')
    } finally {
      await starting.dispose()
    }
  })

  it('still sends when the write fails, on what the chat holds', async () => {
    await idleRunningChild()
    vi.mocked(rig.setOption).mockRejectedValueOnce(new Error('child refused'))
    const { id, result } = rig.send('anyway', undefined, { carried: { model: 'gpt-picked' } })
    expect(await result).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
    expect(recordedOptions()?.model).toBeUndefined()
  })

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

describe('a queued send carrying its model and effort', () => {
  async function queued(carried: Readonly<Record<string, string>>): Promise<{
    working: string
    draftId: string
  }> {
    const working = await rig.workingSend()
    const answer = await rig.send('later', 'queue-if-active', { carried }).result
    if (!answer.ok || !('queued' in answer.value)) {
      throw new Error('expected a queued receipt')
    }
    return { working, draftId: answer.value.queued.messageId }
  }

  it('keeps them on the card and applies them when the queue sends it', async () => {
    const { working, draftId } = await queued({ model: 'gpt-picked' })
    expect(rig.setOption).not.toHaveBeenCalled()
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await eventually(() =>
      expect(rig.setOption).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'model', value: 'gpt-picked' })
      )
    )
  })

  it('applies them when the card is sent by hand', async () => {
    const { working, draftId } = await queued({ model: 'gpt-picked' })
    expect(await rig.sendNow(draftId)).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'a')
    await handedOver(await rig.handoffId(draftId))
    expect(rig.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'model', value: 'gpt-picked' })
    )
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
