import { afterEach, describe, expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { forkTestSource } from './structured-agent-session-fork.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  type RestTestRig
} from '../../host/testing/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../host/testing/structured-agent-session-host-test-data'

let rig: RestTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
})

async function foundAdvisor(agent: 'claude' | 'codex' = 'codex') {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const accountHome = {
    variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: '/home/dev/advisor-account'
  }
  await rig.store.founding.commit({
    sessionId: HOST_TEST_SESSION,
    location: HOST_TEST_LOCATION,
    provider: agent,
    accountHome,
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'pid-absent' },
    operation: {
      callerKey: 'client-1',
      operationId: hostTestOperationId(),
      fingerprint: 'found-advisor'
    },
    now: HOST_TEST_NOW,
    advisoryPolicy: {
      schema: 1,
      dataScope: 'published',
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
  })
  return accountHome
}

describe('advisory provider admission', () => {
  it.each(['claude', 'codex'] as const)(
    'refuses an unsupported %s adapter before acquisition',
    async (agent) => {
      const accountHome = await foundAdvisor(agent)
      const result = await rig!.host.attach(
        REST_TEST_CALLER,
        hostTestAttachParams(1, {
          agent,
          provider: agent,
          accountHome,
          providerHandle: undefined
        })
      )
      expect(result).toMatchObject({
        ok: false,
        refusal: {
          code: 'structured_agent_session_unsupported',
          details: { reason: 'hostUnsupported' }
        }
      })
      expect(rig!.adapter.acquire).not.toHaveBeenCalled()
      expect(rig!.store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('released')
    }
  )
})

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: HOST_TEST_SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: HOST_TEST_SESSION,
      fields
    })
  }
}

it.each(['clear', 'compact'] as const)(
  'refuses advisory /%s without changing its context',
  async (command) => {
    await foundAdvisor()
    const result = await rig!.host.conversationCommand(REST_TEST_CALLER, {
      envelope: envelope('agentSession.conversationCommand', { command }),
      command
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'advisoryOperationUnsupported' } }
    })
    expect(rig!.store.getRecord(HOST_TEST_SESSION)?.providerContextBoundary).toBeUndefined()
    expect(rig!.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('refuses advisory model changes without saving a new choice', async () => {
  await foundAdvisor()
  const fields = { key: 'model', value: 'gpt-live' }
  const result = await rig!.host.setOption(REST_TEST_CALLER, {
    envelope: envelope('agentSession.setOption', fields),
    ...fields
  })
  expect(result).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'advisoryOperationUnsupported' } }
  })
  expect(rig!.store.getRecord(HOST_TEST_SESSION)?.options).toBeUndefined()
  expect(rig!.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses advisory goals and rewinds before acquiring an agent', async () => {
  await foundAdvisor()
  const change = { kind: 'set' as const, objective: 'keep working' }
  const goal = await rig!.host.changeThreadGoal(REST_TEST_CALLER, {
    envelope: envelope('agentSession.threadGoal', { change }),
    change
  })
  const fields = { itemId: 'saved-answer', expectedEpoch: 'old-epoch' }
  const rewind = await rig!.host.rewind(REST_TEST_CALLER, {
    envelope: envelope('agentSession.rewind', fields),
    ...fields
  })
  expect(goal).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'advisoryOperationUnsupported' } }
  })
  expect(rewind).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'advisoryOperationUnsupported' } }
  })
  expect(rig!.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses an advisory transcript fork before copying provider context', async () => {
  await foundAdvisor()
  const source = forkTestSource(rig!)
  source.record.schemaVersion = 3
  source.record.advisoryPolicy = rig!.store.getRecord(HOST_TEST_SESSION)!.advisoryPolicy
  await expect(source.prepare()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'advisoryOperationUnsupported' }
    }
  })
  expect(source.copy).not.toHaveBeenCalled()
})

it('refuses advisory approval answers before changing permission state', async () => {
  await foundAdvisor()
  const fields = {
    itemId: 'pending-permission',
    expectedRevision: 1,
    optionId: 'allowForSession',
    answers: undefined
  }
  const result = await rig!.host.respondToPrompt(REST_TEST_CALLER, {
    envelope: envelope('agentSession.respondTo:approval', fields),
    kind: 'approval',
    ...fields
  })
  expect(result).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'advisoryOperationUnsupported' } }
  })
  expect(rig!.store.getRecord(HOST_TEST_SESSION)?.permissionMode).toBeUndefined()
  expect(rig!.adapter.acquire).not.toHaveBeenCalled()
})
