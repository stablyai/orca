import { expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import { acpStructuredAgentDefinition } from '../../../../acp/session/acp-structured-agent-definitions'
import { StructuredAgentRegistry } from '../../providers/structured-agent-registry'
import { structuredAgentsDeclaringNothing } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import {
  createRestTestRig,
  restTestSend
} from './structured-agent-session-rest-test-rig.test-fixture'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from './structured-agent-session-create.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'

it('advertises agents before the first send and carries the selected intent into it', async () => {
  const rig = await createRestTestRig()
  try {
    const spec = acpLaunchSpecFor('opencode2')
    if (!spec) {
      throw new Error('missing spec')
    }
    const definition = acpStructuredAgentDefinition(spec)
    const limited = structuredAgentsDeclaringNothing([definition]).definition('opencode2')
    if (!limited) {
      throw new Error('missing definition')
    }
    rig.host.deps.agents = new StructuredAgentRegistry([
      {
        definition: { ...limited, restingOptions: definition.restingOptions },
        adapter: rig.host.deps.adapter
      }
    ])
    rig.adapter.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
      acquisitionGeneration: 'preprompt-generation',
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      link: {
        linkId: 'preprompt-link',
        handle: { transport: 'acp', agent: 'opencode2', nativeId: 'ses_first' },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: rig.clock.now
      }
    }))
    rig.host.deps.adapter.readOptions = async () => ({
      models: [],
      current: { agent: 'build' },
      agents: [
        { id: 'build', label: 'Build' },
        { id: 'probe_beta', label: 'Beta' }
      ]
    })
    const created = await rig.host.create(
      CREATE_TEST_CALLER,
      createTestParams(undefined, {
        agent: 'opencode2',
        provider: 'opencode2',
        accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
      })
    )
    expect(created.ok).toBe(true)
    expect(await rig.host.readOptions(HOST_TEST_SESSION)).toMatchObject({
      agents: [{ id: 'build' }, { id: 'probe_beta' }]
    })
    const fence = rig.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    const fields = { key: 'agent', value: 'probe_beta' }
    const picked = await rig.host.setOption(CREATE_TEST_CALLER, {
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: HOST_TEST_SESSION,
          fields
        })
      },
      ...fields
    })
    if (!picked.ok) {
      throw new Error(JSON.stringify(picked.refusal))
    }
    expect(await rig.host.send(CREATE_TEST_CALLER, restTestSend('first', fence))).toMatchObject({
      ok: true
    })
    await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(HOST_TEST_SESSION)
    expect(rig.adapter.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        executionOptions: expect.objectContaining({ agent: 'probe_beta' })
      })
    )
  } finally {
    await rig.dispose()
  }
})
