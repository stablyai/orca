import { afterEach, expect, it, vi } from 'vitest'
import { resolveHostStructuredAgentLaunchEnvironment } from './structured-agent-launch-support'
import type * as Environment from '../environment/structured-agent-shell-environment'

vi.mock('../environment/structured-agent-shell-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof Environment>()),
  resolveHostAgentBaseEnvironment: async () => ({
    TOKEN: 'inherited',
    PATH: '/inherited/bin',
    KEEP: 'keep'
  })
}))
afterEach(() => vi.unstubAllGlobals())

it('uses the configured Windows environment for launch preflight', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const env = await resolveHostStructuredAgentLaunchEnvironment('claude', {
    agentDefaultEnv: { claude: { tOKEN: 'configured', path: '/configured/bin' } }
  })
  expect(env).toEqual({ TOKEN: 'configured', PATH: '/configured/bin', KEEP: 'keep' })
})
