import { describe, expect, it, vi } from 'vitest'
import { applyKimiManagedHomeToLaunchEnv } from './launch-environment'

describe('applyKimiManagedHomeToLaunchEnv', () => {
  it('pins a new local host Kimi launch to the selected managed home', () => {
    const env = applyKimiManagedHomeToLaunchEnv({
      env: { PATH: '/bin' },
      launchAgent: 'kimi',
      connectionId: null,
      runtime: 'host',
      reattached: false,
      getSelectedManagedHomePath: () => '/managed/kimi/account-a/home'
    })

    expect(env).toEqual({ PATH: '/bin', KIMI_CODE_HOME: '/managed/kimi/account-a/home' })
  })

  it.each([
    { name: 'SSH', connectionId: 'ssh-1', runtime: 'host' as const, reattached: false },
    { name: 'WSL', connectionId: null, runtime: 'wsl' as const, reattached: false },
    { name: 'reattach', connectionId: null, runtime: 'host' as const, reattached: true }
  ])(
    'does not leak a host managed home into $name launches',
    ({ connectionId, runtime, reattached }) => {
      const resolver = vi.fn(() => '/managed/kimi/account-a/home')
      const env = { PATH: '/bin' }

      expect(
        applyKimiManagedHomeToLaunchEnv({
          env,
          launchAgent: 'kimi',
          connectionId,
          runtime,
          reattached,
          getSelectedManagedHomePath: resolver
        })
      ).toBe(env)
      expect(resolver).not.toHaveBeenCalled()
    }
  )

  it('leaves the system-default environment untouched', () => {
    const env = { KIMI_CODE_HOME: '/user/explicit/home' }
    expect(
      applyKimiManagedHomeToLaunchEnv({
        env,
        launchAgent: 'kimi',
        connectionId: null,
        runtime: 'host',
        reattached: false,
        getSelectedManagedHomePath: () => null
      })
    ).toBe(env)
  })
})
