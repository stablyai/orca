import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { chatNamingAgentTarget } from './structured-chat-naming-agent-launch'

afterEach(() => vi.unstubAllGlobals())

it('reapplies configured Windows naming variables and keeps the recorded account pin', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const target = await chatNamingAgentTarget(
    agentSessionRecordFixture(),
    '/workspace',
    async () => ({
      TOKEN: 'inherited',
      PATH: '/inherited/bin',
      CLAUDE_CONFIG_DIR: '/ambient/home'
    }),
    { agentDefaultEnv: { claude: { tOKEN: 'configured', path: '/configured/bin' } } }
  )
  if (target.kind !== 'local') {
    throw new Error('Naming did not resolve a local launch')
  }
  expect(target.env).toEqual({
    TOKEN: 'configured',
    PATH: '/configured/bin',
    CLAUDE_CONFIG_DIR: '/home/user/.claude'
  })
})
