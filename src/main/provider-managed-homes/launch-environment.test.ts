import { describe, expect, it, vi } from 'vitest'
import { applyManagedProviderHomeToLaunchEnv } from './launch-environment'

describe.each([
  ['grok', 'GROK_HOME'],
  ['gemini', 'GEMINI_CLI_HOME']
] as const)('managed %s launch environment', (provider, envKey) => {
  it('pins only a new local host launch', () => {
    expect(
      applyManagedProviderHomeToLaunchEnv({
        provider,
        env: { PATH: '/bin' },
        launchAgent: provider,
        connectionId: null,
        runtime: 'host',
        reattached: false,
        getSelectedManagedHomePath: () => '/managed/home'
      })
    ).toEqual({ PATH: '/bin', [envKey]: '/managed/home' })
  })

  it.each([
    ['SSH', 'ssh-1', 'host', false],
    ['WSL', null, 'wsl', false],
    ['reattach', null, 'host', true]
  ] as const)(
    'does not resolve a host credential for %s',
    (_name, connectionId, runtime, reattached) => {
      const resolver = vi.fn(() => '/managed/home')
      const env = { PATH: '/bin' }
      expect(
        applyManagedProviderHomeToLaunchEnv({
          provider,
          env,
          launchAgent: provider,
          connectionId,
          runtime,
          reattached,
          getSelectedManagedHomePath: resolver
        })
      ).toBe(env)
      expect(resolver).not.toHaveBeenCalled()
    }
  )
})
