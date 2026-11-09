import { afterEach, expect, it, vi } from 'vitest'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['win32', { TOKEN: 'configured', PATH: '/configured/bin', KEEP: 'keep' }],
  [
    'linux',
    {
      TOKEN: 'inherited',
      PATH: '/inherited/bin',
      tOKEN: 'configured',
      path: '/configured/bin',
      KEEP: 'keep'
    }
  ]
] as const)('composes the effective agent environment on %s', async (platform, expected) => {
  vi.stubGlobal('process', { ...process, platform })
  const environment = createStructuredAgentEnvironmentResolvers({
    resolveEnvironment: async () => ({ TOKEN: 'inherited', PATH: '/inherited/bin', KEEP: 'keep' }),
    resolveAgentLaunchEnv: () => ({ tOKEN: 'configured', path: '/configured/bin' })
  })
  expect(await environment.resolveAgentEnvironment('claude')).toEqual(expected)
  expect(await environment.resolveAgentEnvironment('codex')).toEqual(expected)
})
