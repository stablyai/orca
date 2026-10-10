import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call, runtimeCalls } from './structured-agent-session-rpc.test-fixture'
import { stopCreatedChat } from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { AgentSessionPreSpawnError } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'

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

function params(options?: Readonly<Record<string, string>>, withMessage = false) {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW,
    ...(options ? { options } : {}),
    ...(withMessage
      ? {
          firstMessage: { clientMessageId: hostTestOperationId(), body: hostTestMessage('opening') }
        }
      : {})
  })
}

it('a capable client creates a blank chat without acquire', async () => {
  expect(await call('agentSession.create', params(), capable)).toMatchObject({
    ok: true,
    result: { ok: true, value: { page: { submissions: [] } } }
  })
  expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledOnce()
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

it('merges held option overrides with host seeds before the first acquisition', async () => {
  const input = params({ model: 'held-model' })
  expect(await call('agentSession.create', input, capable)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'held-model', effort: 'medium' })
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(await rig.host.send({ callerKey: 'client-1' }, restTestSend('first work'))).toMatchObject({
    ok: true
  })
  await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
  expect(rig.adapter.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ options: { model: 'held-model', effort: 'medium' } })
  )
})

it('rejects an explicit option the resting agent would reject before founding', async () => {
  expect(
    await call('agentSession.create', params({ unknownOption: 'yes' }), capable)
  ).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { details: { reason: 'optionRejected' } } }
  })
  expect(rig.store.getRecord(SESSION)).toBeNull()
  expect(rig.store.listOperationRows()).toEqual([])
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each(['options', 'firstMessage'] as const)(
  'rejects changes to firstMessage or explicit options under a replayed create operation: %s',
  async (field) => {
    const original = params({ model: 'held-model' }, true)
    // Keep delivery held while reusing the create id with different intent.
    expect(
      await call('agentSession.create', original, capable, {
        publishStructuredAgentSessionTab: async () => {
          throw new Error('deferred tab')
        }
      })
    ).toMatchObject({ ok: true, result: { ok: false } })
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'held-model', effort: 'medium' })
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
