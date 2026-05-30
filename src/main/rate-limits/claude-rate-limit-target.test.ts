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

  it('uses the configured WSL agent runtime and distro', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        legacySettingsWithoutAccountRuntime({
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'wsl',
          localAgentWslDistro: 'Ubuntu',
          terminalWindowsWslDistro: 'Debian'
        }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('uses the Windows WSL terminal setting when agent runtime is implicit', () => {
    expect(
      getInitialClaudeRateLimitTarget(
        legacySettingsWithoutAccountRuntime({
          ...getDefaultSettings('/tmp'),
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
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
