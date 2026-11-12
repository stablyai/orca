import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { createPiRpcLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'

describe('Pi launch image shrinking', () => {
  it.each([
    ['1.5.0', undefined],
    ['1.5.1', true]
  ])('Pi %s shrinks every image it is sent: %s', async (version, shrinksImages) => {
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'pi' as const,
      providerHandleChain: [],
      accountHome: { variable: 'PI_CODING_AGENT_DIR' as const, path: '/account' }
    }
    const resolve = createPiRpcLaunchResolver({
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      resolveCommand: () => '/host/bin/pi',
      probeVersion: async () => ({ version }),
      ensureBackgroundWorkBridge: async () => null
    })

    const launch = await resolve({
      sessionId: record.sessionId,
      workspaceId: 'ws-1',
      hostId: 'host-1',
      agent: 'pi',
      providerHandle: null
    })

    expect(launch.shrinksImages).toBe(shrinksImages)
  })
})
