import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'
import { getInitialClaudeRateLimitTarget } from './claude-rate-limit-target'

function legacySettingsWithoutAccountRuntime(settings: GlobalSettings): GlobalSettings {
  const next = { ...settings } as Partial<GlobalSettings>
  delete next.localAccountRuntime
  return next as GlobalSettings
}

describe('getInitialClaudeRateLimitTarget', () => {
  it('uses the configured WSL account runtime before agent detection runtime', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'wsl',
          localAccountWslDistro: 'Fedora',
          localAgentRuntime: 'host',
          terminalWindowsWslDistro: 'Debian'
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Fedora' })
  })

  it('uses the single selected WSL account distro when account runtime is WSL default', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'wsl',
          activeClaudeManagedAccountIdsByRuntime: {
            host: 'host-account-1',
            wsl: { Ubuntu: 'wsl-account-1' }
          }
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('ignores stale terminal WSL distro when account runtime is WSL default', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'wsl',
          localAccountWslDistro: null,
          terminalWindowsWslDistro: 'Debian',
          activeClaudeManagedAccountIdsByRuntime: {
            host: 'host-account-1',
            wsl: {}
          }
        },
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: null })
  })

  it('uses the global WSL project runtime default when account runtime is unset', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        legacySettingsWithoutAccountRuntime({
          ...getDefaultSettings('/tmp'),
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
          localAgentRuntime: 'host',
          terminalWindowsWslDistro: 'Debian'
        }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('ignores stale legacy WSL agent and terminal settings when the project default is host', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        legacySettingsWithoutAccountRuntime({
          ...getDefaultSettings('/tmp'),
          localWindowsRuntimeDefault: { kind: 'windows-host' },
          localAgentRuntime: 'wsl',
          localAgentWslDistro: 'Ubuntu',
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian'
        }),
        'win32'
      )
    ).toEqual({ runtime: 'host' })
  })

  it('uses a single WSL-only active account after restart', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        legacySettingsWithoutAccountRuntime({
          ...getDefaultSettings('/tmp'),
          activeClaudeManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'wsl-account-1' }
          }
        })
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('keeps explicit host runtime on host', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'host',
          localAgentRuntime: 'host',
          terminalWindowsShell: 'wsl.exe',
          activeClaudeManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'wsl-account-1' }
          }
        },
        'win32'
      )
    ).toEqual({ runtime: 'host' })
  })
})
