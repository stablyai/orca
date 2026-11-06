import { describe, expect, it, vi } from 'vitest'
import { HostAccountLaunchEnvParams } from '../../shared/host-account-launch-env'

import {
  RuntimeAccountController,
  type RuntimeAccountServices
} from './agent-session/environment/runtime-account-controller'
import { withHostAccountLaunchEnv } from './terminal/launch/runtime-agent-terminal-startup'

export function registerHostAccountLaunchEnvTests(): void {
  const LAUNCH_ENV = HostAccountLaunchEnvParams.parse({
    wslDistro: 'Ubuntu',
    claude: {
      CLAUDE_CONFIG_DIR: '/home/u/.orca/claude/a',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/.orca/claude/a',
      CODEX_HOME: '/home/u/.orca/codex/b'
    },
    terminal: {
      ORCA_CLAUDE_PROFILE_POINTER: '~/.orca/claude-pointer',
      CODEX_HOME: '/home/u/.orca/codex/b'
    }
  })

  describe('RuntimeAccountController host launch env', () => {
    it('refuses where the host has account services of its own', () => {
      const accounts = new RuntimeAccountController()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only presence is read.
      accounts.setServices({} as RuntimeAccountServices)
      expect(() => accounts.setHostLaunchEnv(LAUNCH_ENV)).toThrow(/its own provider accounts/)
    })
  })

  describe('withHostAccountLaunchEnv', () => {
    it('keeps what the caller passed: its env and its own accountEnv win', () => {
      const requested = {
        env: { CODEX_HOME: '/caller' },
        accountEnv: { CLAUDE_CONFIG_DIR: '/hint' }
      }
      expect(
        withHostAccountLaunchEnv(requested, { env: requested.env }, LAUNCH_ENV.claude).env
      ).toMatchObject({ CODEX_HOME: '/caller', CLAUDE_CONFIG_DIR: '/hint' })
    })
  })

  describe('restoreHostLaunchEnv', () => {
    it('keeps applying a push whose save failed', () => {
      const accounts = new RuntimeAccountController()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      accounts.restoreHostLaunchEnv(null, () => {
        throw new Error('disk full')
      })
      accounts.setHostLaunchEnv(LAUNCH_ENV)
      expect(accounts.hostLaunchEnvFor('claude')).toEqual(LAUNCH_ENV.claude)
      vi.restoreAllMocks()
    })
  })
}
