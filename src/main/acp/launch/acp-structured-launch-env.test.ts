import { afterEach, expect, it, vi } from 'vitest'
import { acpLaunchSpecFor } from './acp-launch-registry'
import { resolveAcpLaunchInvocation } from './acp-structured-launch-resolution'

afterEach(() => vi.unstubAllGlobals())

it('composes configured Windows values before ACP command lookup and account pinning', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const spec = acpLaunchSpecFor('grok')
  if (!spec) {
    throw new Error('Missing Grok spec')
  }
  const launch = await resolveAcpLaunchInvocation(
    { ...spec, installDirectories: () => [] },
    { variable: 'GROK_HOME', path: '/pinned' },
    {
      dataDirectory: '/isolated',
      inheritedEnv: {},
      resolveEnvironment: async () => ({ PATH: '/inherited/bin', TOKEN: 'inherited' }),
      resolveLaunchEnv: () => ({
        path: '/configured/bin',
        tOKEN: 'configured',
        grok_home: '/configured/home'
      }),
      resolveCommand: (_command, options) => {
        expect(options?.pathEnv).toBe('/configured/bin')
        return '/configured/bin/grok.exe'
      }
    }
  )
  expect(launch.env).toEqual({ PATH: '/configured/bin', TOKEN: 'configured', GROK_HOME: '/pinned' })
})
