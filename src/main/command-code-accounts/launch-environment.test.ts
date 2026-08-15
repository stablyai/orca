import { describe, expect, it, vi } from 'vitest'
import { applyCommandCodeManagedCredentialToLaunchEnv } from './launch-environment'

describe('applyCommandCodeManagedCredentialToLaunchEnv', () => {
  it('pins a new local host Command Code launch to the selected credential', () => {
    const env = applyCommandCodeManagedCredentialToLaunchEnv({
      env: { PATH: '/bin' },
      launchAgent: 'command-code',
      connectionId: null,
      runtime: 'host',
      reattached: false,
      getSelectedApiKey: () => 'cc-account-a'
    })

    expect(env).toEqual({ PATH: '/bin', COMMAND_CODE_API_KEY: 'cc-account-a' })
  })

  it.each([
    { name: 'SSH', connectionId: 'ssh-1', runtime: 'host' as const, reattached: false },
    { name: 'WSL', connectionId: null, runtime: 'wsl' as const, reattached: false },
    { name: 'reattach', connectionId: null, runtime: 'host' as const, reattached: true }
  ])(
    'does not leak a host credential into $name launches',
    ({ connectionId, runtime, reattached }) => {
      const resolver = vi.fn(() => 'cc-account-a')
      const env = { PATH: '/bin' }

      expect(
        applyCommandCodeManagedCredentialToLaunchEnv({
          env,
          launchAgent: 'command-code',
          connectionId,
          runtime,
          reattached,
          getSelectedApiKey: resolver
        })
      ).toBe(env)
      expect(resolver).not.toHaveBeenCalled()
    }
  )

  it('leaves the system-default environment untouched', () => {
    const env = { COMMAND_CODE_API_KEY: 'user-env-key' }
    expect(
      applyCommandCodeManagedCredentialToLaunchEnv({
        env,
        launchAgent: 'command-code',
        connectionId: null,
        runtime: 'host',
        reattached: false,
        getSelectedApiKey: () => null
      })
    ).toBe(env)
  })
})
