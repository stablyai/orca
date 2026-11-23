import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { AgentSessionRefusalError } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { computeAgentSessionPayloadFingerprint } from '../../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})

afterEach(async () => {
  await rig.dispose()
  vi.restoreAllMocks()
})

function stubRuntime() {
  return {
    getAgentProviderSessionRows: () => [],
    getStructuredAgentCliSourceRoute: () => 'unknown' as const,
    resolveStructuredAgentSessionCreateIntent: async () => {
      const { providerHandle: _ph, ...resolved } = hostTestAttachParams(null, {
        provider: 'codex',
        agent: 'codex',
        providerHandle: undefined
      })
      return resolved
    }
  }
}

function createEnvelope() {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: 0,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.create',
      sessionId: SESSION,
      fields: { agent: 'codex' }
    })
  }
}

it.each([undefined, true] as const)(
  'allows legacy codex fastMode in create options when atRest is %s',
  async (atRest) => {
    const prepared = await prepareStructuredAgentSessionCreateForWorktree({
      runtime: stubRuntime(),
      ensureHost: async () => rig.host,
      envelope: createEnvelope(),
      worktree: '/workspace',
      agent: 'codex',
      caller: { callerKey: 'client-1' },
      options: { fastMode: 'true' },
      ...(atRest !== undefined ? { atRest } : {})
    })
    expect(prepared.attachParams.options).toMatchObject({ fastMode: 'true' })
  }
)

it('rejects unsupported option keys on codex create', async () => {
  await expect(
    prepareStructuredAgentSessionCreateForWorktree({
      runtime: stubRuntime(),
      ensureHost: async () => rig.host,
      envelope: createEnvelope(),
      worktree: '/workspace',
      agent: 'codex',
      caller: { callerKey: 'client-1' },
      options: { unsupportedOption: 'true' },
      atRest: true
    })
  ).rejects.toBeInstanceOf(AgentSessionRefusalError)
})
