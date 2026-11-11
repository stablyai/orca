import { expect, it } from 'vitest'
import { StructuredAgentSessionAdapterRouter } from '../../providers/structured-agent-session-adapter-router'
import { claudeAndCodexAgents } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'

it.each([
  { agent: undefined, supportsHooks: true, expected: true },
  { agent: undefined, supportsHooks: false, expected: undefined },
  { agent: 'claude' as const, supportsHooks: true, expected: undefined }
])(
  'advertises hook review through the host router only for a supporting Codex registration ($agent, $supportsHooks)',
  async ({ agent, supportsHooks, expected }) => {
    const rig = await createQueuedMessageTestRig({ atRest: true, ...(agent ? { agent } : {}) })
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
