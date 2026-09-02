import { describe, expect, it } from 'vitest'
import {
  applyTerminalGitCredentialPromptGuard,
  TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV
} from './terminal-git-credential-guard'

function expectGuarded(env: Record<string, string>): void {
  expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  expect(env.GCM_INTERACTIVE).toBe('never')
  expect(Object.values(env)).toContain('credential.interactive')
  expect(Object.values(env)).toContain('credential.guiPrompt')
  expect(Object.values(env)).not.toContain('credential.helper')
}

describe('applyTerminalGitCredentialPromptGuard', () => {
  it('guards an agent terminal on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const env: Record<string, string> = { PATH: '/usr/bin' }

      expect(
        applyTerminalGitCredentialPromptGuard(env, {
          launchCommand: 'claude',
          platform
        })
      ).toBe(true)
      expectGuarded(env)
    }
  })

  it('guards a headless one-shot agent launch', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }

    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        launchCommand: 'claude -p "fix the tests"',
        platform: 'darwin'
      })
    ).toBe(true)
    expectGuarded(env)
  })

  it('guards a trusted agent whose wrapped command is not recognizable', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }

    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        launchCommand: 'cd /repo && custom-agent-wrapper',
        isUnattended: true,
        platform: 'linux'
      })
    ).toBe(true)
    expectGuarded(env)
  })

  it('leaves ordinary user terminals unchanged on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const original = {
        PATH: '/usr/bin',
        GIT_TERMINAL_PROMPT: '1',
        GCM_INTERACTIVE: 'auto',
        GIT_ASKPASS: '/usr/local/bin/user-askpass'
      }
      const env = { ...original }

      expect(
        applyTerminalGitCredentialPromptGuard(env, {
          launchCommand: '/bin/zsh',
          platform
        })
      ).toBe(false)
      expect(env).toEqual(original)
    }
  })

  it('does not treat a generic Orca CLI command as an agent', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }

    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        launchCommand: 'orca status',
        platform: 'linux'
      })
    ).toBe(false)
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('guards explicitly marked automation and consumes its internal marker', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
    }

    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        launchCommand: '/bin/zsh',
        platform: 'linux'
      })
    ).toBe(true)
    expectGuarded(env)
    expect(env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]).toBeUndefined()
  })

  it('preserves caller askpass and indexed config when appending the guard', () => {
    const env: Record<string, string> = {
      GIT_ASKPASS: '/usr/local/bin/user-askpass',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
    }

    applyTerminalGitCredentialPromptGuard(env, {
      launchCommand: 'claude',
      platform: 'linux'
    })

    expect(env.GIT_ASKPASS).toBe('/usr/local/bin/user-askpass')
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.proxy')
    expect(env.GIT_CONFIG_VALUE_0).toBe('http://proxy.invalid')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.interactive')
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
  })

  it('registers a guarded Windows agent environment for WSL forwarding', () => {
    const env: Record<string, string> = { PATH: 'C:\\Windows\\System32' }

    applyTerminalGitCredentialPromptGuard(env, {
      launchCommand: 'claude',
      platform: 'win32'
    })

    const wslenvKeys = (env.WSLENV ?? '').split(':')
    expect(wslenvKeys).toContain('GIT_TERMINAL_PROMPT')
    expect(wslenvKeys).toContain('GCM_INTERACTIVE')
    expect(wslenvKeys).toContain('GIT_CONFIG_COUNT')
    expect(wslenvKeys).toContain('GIT_CONFIG_KEY_0')
    expect(wslenvKeys).toContain('GIT_CONFIG_VALUE_0')
    expect(wslenvKeys).not.toContain('GIT_ASKPASS')
    expect(wslenvKeys).not.toContain('SSH_ASKPASS')
  })

  it('forwards only the guard decision and scalars to a detached host', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      GIT_ASKPASS: '/usr/local/bin/user-askpass',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_VALUE_0: 'false'
    }

    expect(
      applyTerminalGitCredentialPromptGuard(env, {
        launchCommand: 'claude',
        platform: 'win32',
        deferGitConfigGuardToHost: true
      })
    ).toBe(true)

    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.GIT_ASKPASS).toBe('/usr/local/bin/user-askpass')
    expect(env.SSH_ASKPASS).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('core.quotePath')
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined()
    expect(env.WSLENV).toBeUndefined()
    expect(env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]).toBe('guard')
  })

  it('does not add premature WSL forwarding entries to a detached-host wire env', () => {
    const env: Record<string, string> = {
      WSLENV: 'CALLER_VALUE/p',
      [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard'
    }

    applyTerminalGitCredentialPromptGuard(env, {
      platform: 'win32',
      deferGitConfigGuardToHost: true
    })

    expect(env.WSLENV).toBe('CALLER_VALUE/p')
  })
})
