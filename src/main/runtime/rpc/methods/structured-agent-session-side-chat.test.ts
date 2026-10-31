import { optionSession } from '../../../codex/codex-structured-option-session.test-fixture'
import { resolvedCodexMessageOptions } from '../../../codex/codex-structured-message-options'
import { startCodexTurn } from '../../../codex/codex-structured-turn-start'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../mobile/src/transport/mobile-runtime-client-capabilities'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { resolveStructuredSideChatSource } from '../../../native-chat/structured-side-chat-source'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SOURCE,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from './structured-agent-session-rpc.test-fixture'
import type { StructuredAgentSessionCreateIntentInput } from '../../structured-agent-session-create-adoption'

let rig: RestTestRig
const CHILD = 'codex_side_child'
const client = {
  clientId: 'phone',
  clientKind: 'mobile' as const,
  clientCapabilities: [...MOBILE_RUNTIME_CLIENT_CAPABILITIES]
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
  expect((await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))).ok).toBe(true)
  const acquire = rig.adapter.acquire.getMockImplementation()
  if (!acquire) {
    throw new Error('Missing acquisition fixture')
  }
  rig.adapter.acquire.mockImplementation(async (input) => {
    const acquired = await acquire(input)
    return {
      ...acquired,
      link: {
        linkId: 'child-link',
        handle: codexProviderHandle('child-thread'),
        origin: 'created',
        mintedAtFence: input.fence,
        observedAt: rig.clock.now
      }
    }
  })
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

function create(withQuestion: boolean) {
  return structuredAgentSessionCreateParams({
    sessionId: CHILD,
    worktree: 'id:workspace-1',
    agent: 'codex',
    sideChatOf: SOURCE,
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: rig.clock.now,
    ...(withQuestion
      ? {
          firstMessage: {
            clientMessageId: hostTestOperationId(),
            body: hostTestMessage('Why this approach?')
          }
        }
      : {})
  })
}

const runtime = {
  requireStore: () => ({ getSettings: () => ({ experimentalNativeChat: false }) }),
  resolveStructuredAgentSessionCreateIntent: async (
    input: StructuredAgentSessionCreateIntentInput
  ) => {
    const { providerHandle: _sourceHandle, ...base } = hostTestAttachParams(null)
    return {
      ...base,
      envelope: { ...base.envelope, ...input.envelope },
      ...resolveStructuredSideChatSource({
        host: rig.host,
        sourceSessionId: SOURCE,
        sessionId: input.envelope.sessionId,
        agent: input.agent,
        location: base.location
      })
    }
  }
}

it('opens an empty side chat with a distinct provider identity and preserves the source', async () => {
  const before = structuredClone(rig.store.getRecord(SOURCE))
  const support = await call(
    'agentSession.createSupport',
    { worktree: 'id:workspace-1', agent: 'codex' },
    client,
    runtime
  )
  expect(support, JSON.stringify(support)).toMatchObject({
    ok: false,
    error: {
      message: 'structured_agent_session_unsupported',
      data: { refusal: { code: 'structured_agent_session_unsupported' } }
    }
  })
  expect(await call('agentSession.create', create(false), client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true, value: { sessionId: CHILD } }
  })
  expect(rig.store.getRecord(CHILD)?.sideChat?.sourceSessionId).toBe(SOURCE)
  expect(rig.store.getRecord(CHILD)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(
    'child-thread'
  )
  expect(rig.store.getRecord(SOURCE)).toEqual(before)
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it('delivers /btw’s question once to the child across a replayed create', async () => {
  const input = create(true)
  const before = await rig.host.journalSnapshot(SOURCE)
  const first = await call('agentSession.create', input, client, runtime)
  expect(first, JSON.stringify(first)).toMatchObject({
    ok: true,
    result: {
      ok: true,
      value: {
        sessionId: CHILD,
        firstMessage: { clientMessageId: input.firstMessage?.clientMessageId }
      }
    }
  })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.dispatch.mock.calls[0]?.[0]).toMatchObject({
    sessionId: CHILD,
    body: { blocks: [{ type: 'text', text: 'Why this approach?' }] }
  })
  expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true, replayed: true }
  })
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  expect(rig.adapter.dispatch).toHaveBeenCalledOnce()
  expect(await rig.host.journalSnapshot(SOURCE)).toEqual(before)
})

it('refuses a combined resume and side-chat request before starting another child', async () => {
  const input = structuredAgentSessionCreateParams({
    ...create(false),
    sessionId: CHILD,
    resumeFrom: { providerSessionId: 'parent-thread' },
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa'
  })
  expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
    ok: false,
    error: { code: 'agent_session_operation_invalid' }
  })
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
})

it('changes the child permission independently without changing the source chat', async () => {
  const sourceBefore = structuredClone(rig.store.getRecord(SOURCE))
  expect(await call('agentSession.create', create(false), client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  const fields = { key: 'permissionMode', value: 'full-access' }
  const result = await rig.host.setOption(REST_TEST_CALLER, {
    ...fields,
    envelope: {
      sessionId: CHILD,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: rig.store.getRecord(CHILD)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId: CHILD,
        fields
      })
    }
  })
  expect(result).toMatchObject({ ok: true })
  expect(rig.store.getRecord(CHILD)?.permissionMode).toBe('full-access')
  expect(rig.store.getRecord(SOURCE)).toEqual(sourceBefore)
})

it('creates a read-only child without changing the parent and keeps the mode across create replay', async () => {
  const parent = structuredClone(rig.store.getRecord(SOURCE))
  const input = structuredAgentSessionCreateParams({
    ...create(false),
    sessionId: CHILD,
    options: { permissionMode: 'read-only' },
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: rig.clock.now
  })
  for (const _attempt of [1, 2]) {
    expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(rig.store.getRecord(CHILD)?.permissionMode).toBe('read-only')
    expect(rig.store.getRecord(SOURCE)).toEqual(parent)
  }
})

it('refuses changed explicit permissions for the same side-chat create operation', async () => {
  const input = structuredAgentSessionCreateParams({
    ...create(false),
    sessionId: CHILD,
    options: { permissionMode: 'read-only' },
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: rig.clock.now
  })
  expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  const changed = { ...input, options: { permissionMode: 'full-access' } }
  changed.envelope = {
    ...input.envelope,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.create',
      sessionId: CHILD,
      fields: {
        worktree: input.worktree,
        agent: input.agent,
        sideChatOf: input.sideChatOf,
        options: changed.options
      }
    })
  }
  expect(await call('agentSession.create', changed, client, runtime)).toMatchObject({
    ok: true,
    result: { ok: false, refusal: { code: 'agent_session_operation_conflict' } }
  })
  expect(rig.store.getRecord(CHILD)?.permissionMode).toBe('read-only')
  expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
})

const sourceModelOptions = {
  model: 'gpt-5.6-sol',
  effort: 'medium',
  fastMode: 'true',
  serviceTier: 'priority'
}
const childSelections: {
  name: string
  picked: Record<string, string>
  expected: Record<string, string>
}[] = [
  {
    name: 'effort only',
    picked: { effort: 'high' },
    expected: { ...sourceModelOptions, effort: 'high' }
  },
  {
    name: 'fast mode only',
    picked: { fastMode: 'false' },
    expected: {
      model: sourceModelOptions.model,
      effort: sourceModelOptions.effort,
      fastMode: 'false'
    }
  },
  {
    name: 'explicit tier with Fast',
    picked: { fastMode: 'false', serviceTier: 'priority' },
    expected: { ...sourceModelOptions, fastMode: 'false' }
  },
  { name: 'explicit model', picked: { model: 'gpt-6.1-sol' }, expected: { model: 'gpt-6.1-sol' } }
]

it.each(childSelections)(
  'keeps source selections unless the child replaces its model: $name',
  async ({ picked, expected }) => {
    const parent = rig.store.getRecord(SOURCE)!
    await rig.store.replaceSessionOptions({
      sessionId: SOURCE,
      fence: parent.lease.runtimeFence,
      options: sourceModelOptions,
      now: rig.clock.now
    })
    await rig.store.replaceSessionOptions({
      sessionId: SOURCE,
      fence: parent.lease.runtimeFence,
      permissionMode: 'ask',
      now: rig.clock.now
    })
    const sourceBefore = structuredClone(rig.store.getRecord(SOURCE))
    const input = structuredAgentSessionCreateParams({
      ...create(false),
      sessionId: CHILD,
      options: picked,
      randomUuid: () => '00000000-0000-0000-0000-0000000eff01',
      now: rig.clock.now
    })
    for (const _attempt of [1, 2]) {
      expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
        ok: true,
        result: { ok: true }
      })
      expect.soft(rig.store.getRecord(CHILD)?.options).toEqual(expected)
      expect(rig.store.getRecord(CHILD)?.permissionMode).toBe('ask')
      if (picked.fastMode !== undefined) {
        const request = vi.fn(async () => ({ turn: { id: 'child-turn' } }))
        const native = optionSession(request)
        const turnOptions = await resolvedCodexMessageOptions(
          native,
          rig.store.getRecord(CHILD)?.options
        )
        await startCodexTurn(native, {
          clientMessageId: hostTestOperationId(),
          body: hostTestMessage('Continue the side question'),
          turnOptions
        })
        expect(request).toHaveBeenLastCalledWith(
          'turn/start',
          expect.objectContaining({
            model: sourceModelOptions.model,
            serviceTier: picked.serviceTier ?? 'default'
          }),
          expect.anything()
        )
      }
      expect(rig.store.getRecord(SOURCE)).toEqual(sourceBefore)
    }
  }
)
