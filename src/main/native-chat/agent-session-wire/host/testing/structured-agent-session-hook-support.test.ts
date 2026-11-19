import { expect, it } from 'vitest'
import { StructuredAgentSessionAdapterRouter } from '../../providers/structured-agent-session-adapter-router'
import { claudeAndCodexAgents } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { createTestParams } from './structured-agent-session-create.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER
} from './structured-agent-session-rest-test-rig.test-fixture'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data.test-fixture'

it.each([
  { agent: undefined, supportsHooks: true, expected: true },
  { agent: undefined, supportsHooks: false, expected: undefined },
  { agent: 'claude' as const, supportsHooks: true, expected: undefined }
])(
  'advertises hook review through the host router only for a supporting Codex registration ($agent, $supportsHooks)',
  async ({ agent, supportsHooks, expected }) => {
    const rig = await createRestTestRig()
    const created = await rig.host.create(
      REST_TEST_CALLER,
      createTestParams(
        undefined,
        agent === 'claude'
          ? {
              agent,
              provider: agent,
              accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/private-fixture/claude' }
            }
          : {}
      )
    )
    expect(created).toMatchObject({ ok: true })
    const provider = rig.host.deps.adapter
    const agents = claudeAndCodexAgents({
      claude: provider,
      codex: {
        ...provider,
        ...(supportsHooks
          ? {
              reviewHooks: async () => {
                throw new Error('Reading capability must not execute hooks')
              }
            }
          : {})
      }
    })
    rig.host.deps.agents = agents
    rig.host.deps.adapter = new StructuredAgentSessionAdapterRouter(agents, () => Promise.resolve())
    try {
      expect((await rig.host.readOptions(HOST_TEST_SESSION)).hookTrust).toBe(expected)
    } finally {
      await rig.dispose()
    }
  }
)
