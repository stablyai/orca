import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../../../shared/agent-session/structured-agent-session-create'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-create-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { AgentSessionMutationEnvelope } from '../../../../../../shared/agent-session/agent-session-wire'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { call } from '../protocol/structured-agent-session-rpc.test-fixture'

const POLICY = {
  schema: 1 as const,
  dataScope: 'published' as const,
  sourcePin: 'a'.repeat(40),
  deadlineAt: HOST_TEST_NOW + 300_000,
  maxModelCalls: 4,
  artifacts: [
    {
      path: 'note.txt',
      text: 'hello',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    }
  ]
}
const CLIENT = {
  clientId: 'advisor-client',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
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

function request() {
  const input = {
    sessionId: HOST_TEST_SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: HOST_TEST_NOW,
    advisoryPolicy: structuredClone(POLICY)
  }
  return structuredAgentSessionCreateParams(input)
}

function create(input: unknown) {
  return call('agentSession.create', input, CLIENT, {
    resolveStructuredAgentSessionCreateIntent: async (params: {
      envelope: AgentSessionMutationEnvelope
      agent: string
    }) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: params.agent,
      agent: params.agent,
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      runtimeKind: 'native'
    })
  })
}

it('retains the immutable advisor policy through RPC creation without publishing snapshot text', async () => {
  rig.host.deps.adapter.supportsAdvisoryPolicy = () => true
  const input = request()
  const response = await create(input)
  expect(response).toMatchObject({ ok: true, result: { ok: true } })
  expect(JSON.stringify(response)).not.toContain('hello')
  expect(rig.store.getRecord(HOST_TEST_SESSION)).toMatchObject({
    schemaVersion: 3,
    advisoryPolicy: {
      maxModelCalls: 4,
      sourcePin: 'a'.repeat(40),
      artifacts: [{ text: 'hello' }]
    }
  })
  expect(JSON.stringify(rig.store.listConversations())).not.toContain('hello')
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses changed advisory policy bytes with the original request fingerprint before creation', async () => {
  rig.host.deps.adapter.supportsAdvisoryPolicy = () => true
  const input = { ...request(), advisoryPolicy: { ...POLICY, maxModelCalls: 3 } }
  expect(await create(input)).toMatchObject({
    ok: true,
    result: {
      ok: false,
      refusal: {
        code: 'agent_session_operation_conflict',
        details: { reason: 'fingerprintMismatch' }
      }
    }
  })
  expect(rig.store.getRecord(HOST_TEST_SESSION)).toBeNull()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses an unsupported advisory adapter before founding any conversation', async () => {
  expect(await create(request())).toMatchObject({
    ok: true,
    result: {
      ok: false,
      refusal: {
        code: 'structured_agent_session_unsupported',
        details: { reason: 'hostUnsupported' }
      }
    }
  })
  expect(rig.store.getRecord(HOST_TEST_SESSION)).toBeNull()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})
