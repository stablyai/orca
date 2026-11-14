import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../../../shared/agent-session/structured-agent-session-create'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestMessage,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { call, runtimeCalls } from '../protocol/structured-agent-session-rpc.test-fixture'
import { stopCreatedChat } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-create-test-fixture'
import '../../../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../../../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'

const legacy = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}
const capable = {
  ...legacy,
  clientCapabilities: [
    ...legacy.clientCapabilities,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}
let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

function params(
  options?: Readonly<Record<string, string>>,
  withMessage = false,
  optionsMode?: 'replace-model-selection'
) {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW,
    ...(options ? { options } : {}),
    ...(optionsMode ? { optionsMode } : {}),
    ...(withMessage
      ? {
          firstMessage: { clientMessageId: hostTestOperationId(), body: hostTestMessage('opening') }
        }
      : {})
  })
}

it('refuses a new founding operation before dispatching the same opening again', async () => {
  const input = params(undefined, true)
  expect(await call('agentSession.create', input, capable)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  const retry = {
    ...input,
    envelope: { ...input.envelope, clientOperationId: hostTestOperationId() }
  }
  expect(await call('agentSession.create', retry, capable)).toMatchObject({
    ok: true,
    result: {
      ok: false,
      refusal: { code: 'agent_session_conflict', details: { reason: 'sessionExists' } }
    }
  })
  expect(
    (await rig.host.journalSnapshot(SESSION)).submissions.map((row) => row.clientMessageId)
  ).toEqual([input.firstMessage?.clientMessageId])
  expect(rig.adapter.dispatch).toHaveBeenCalledOnce()
})

it.each([
  { name: 'legacy', client: legacy },
  { name: 'capable', client: capable }
])(
  'a $name client receives its first-message receipt before handshake and on replay after Stop',
  async ({ client }) => {
    const input = params(undefined, true)
    const entered = Promise.withResolvers<void>()
    rig.adapter.acquire.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          entered.resolve()
          signal?.addEventListener(
            'abort',
            () => reject(new AgentSessionPreSpawnError(signal.reason)),
            { once: true }
          )
        })
    )
    expect(await call('agentSession.create', input, client)).toMatchObject({
      ok: true,
      result: {
        ok: true,
        value: {
          firstMessage: {
            clientMessageId: input.firstMessage?.clientMessageId,
            dispatchState: 'pending'
          },
          page: { submissions: [{ clientMessageId: input.firstMessage?.clientMessageId }] }
        }
      }
    })
    await entered.promise
    await stopCreatedChat(rig.host)
    expect(await call('agentSession.create', input, client)).toMatchObject({
      ok: true,
      result: {
        ok: true,
        replayed: true,
        value: {
          firstMessage: {
            clientMessageId: input.firstMessage?.clientMessageId,
            dispatchState: 'rejected',
            rejection: { kind: 'cancelled' }
          }
        }
      }
    })
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

it('the old client retains acquired create and waits for acquisition before publishing', async () => {
  const acquired = rig.adapter.acquire.getMockImplementation()
  if (!acquired) {
    throw new Error('test acquire missing')
  }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  rig.adapter.acquire.mockImplementationOnce(async (input) => {
    entered.resolve()
    await release.promise
    return acquired(input)
  })
  let answered = false
  const creating = call('agentSession.create', params(), legacy).then((result) => {
    answered = true
    return result
  })
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
  await entered.promise
  expect(answered).toBe(false)
  expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  release.resolve()
  expect(await creating).toMatchObject({ ok: true, result: { ok: true } })
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
})

it('replays an acquired create after the client negotiates create-message support', async () => {
  const input = params()
  expect(await call('agentSession.create', input, legacy)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(await call('agentSession.create', input, capable)).toMatchObject({
    ok: true,
    result: { ok: true, replayed: true, value: { sessionId: SESSION } }
  })
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
})

it('keeps an at-rest replay at rest when the client capability list changes', async () => {
  const input = params()
  expect(await call('agentSession.create', input, capable)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(await call('agentSession.create', input, legacy)).toMatchObject({
    ok: true,
    result: { ok: true, replayed: true }
  })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
})

it.each(['firstMessage', 'options'] as const)(
  'refuses adding %s to an already-acquired create operation',
  async (field) => {
    expect(await call('agentSession.create', params(), legacy)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    const changed =
      field === 'firstMessage' ? params(undefined, true) : params({ model: 'held-model' })
    expect(await call('agentSession.create', changed, capable)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_operation_conflict' } }
    })
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toEqual([])
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  }
)

it('replaces unrelated host model defaults before the first acquisition', async () => {
  const input = params({ model: 'held-model' }, false, 'replace-model-selection')
  expect(await call('agentSession.create', input, capable)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'held-model' })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(await rig.host.send({ callerKey: 'client-1' }, restTestSend('first work'))).toMatchObject({
    ok: true
  })
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
  expect(rig.adapter.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ options: { model: 'held-model' } })
  )
})

it.each(['options', 'firstMessage'] as const)(
  'rejects changes to firstMessage or explicit options under a replayed create operation: %s',
  async (field) => {
    const original = params({ model: 'held-model' }, true, 'replace-model-selection')
    // Keep delivery held while reusing the create id with different intent.
    expect(
      await call('agentSession.create', original, capable, {
        publishStructuredAgentSessionTab: async () => {
          throw new Error('deferred tab')
        }
      })
    ).toMatchObject({ ok: true, result: { ok: false } })
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'held-model' })
    const first = original.firstMessage
    if (!first) {
      throw new Error('fixture first message missing')
    }
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toMatchObject([
      { clientMessageId: first.clientMessageId }
    ])
    const changed = structuredAgentSessionCreateParams({
      sessionId: SESSION,
      worktree: original.worktree,
      agent: original.agent,
      now: NOW,
      randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
      optionsMode: original.optionsMode,
      options: field === 'options' ? { model: 'other-model' } : original.options,
      firstMessage:
        field === 'firstMessage' ? { ...first, body: hostTestMessage('changed') } : first
    })
    expect(await call('agentSession.create', changed, capable)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_operation_conflict' } }
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('answers an old client whose start failed before spawning in plain words', async () => {
  const raw = 'codex sessions pin CODEX_HOME, not CLAUDE_CONFIG_DIR'
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  rig.adapter.acquire.mockRejectedValueOnce(new AgentSessionPreSpawnError(new Error(raw)))

  const answer = await call('agentSession.create', params(), legacy)

  // Thrown as before, so the wire code an old client reads is unchanged; only the words are new.
  expect(answer).toMatchObject({
    ok: false,
    error: {
      code: 'runtime_error',
      message: "Codex couldn't start. Send your message to try again."
    }
  })
  expect(JSON.stringify(answer)).not.toContain(raw)
})
