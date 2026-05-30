import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'
import { getInitialCodexRateLimitTarget } from './codex-rate-limit-target'

function legacySettingsWithoutAccountRuntime(settings: GlobalSettings): GlobalSettings {
  const next = { ...settings } as Partial<GlobalSettings>
  delete next.localAccountRuntime
  return next as GlobalSettings
}

describe('getInitialCodexRateLimitTarget', () => {
  it('uses the configured WSL account runtime before agent detection runtime', () => {
    expect(
      getInitialCodexRateLimitTarget(
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
      getInitialCodexRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'wsl',
          activeCodexManagedAccountIdsByRuntime: {
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
      getInitialCodexRateLimitTarget(
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
      getInitialCodexRateLimitTarget(
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
      getInitialCodexRateLimitTarget(
        legacySettingsWithoutAccountRuntime({
          ...getDefaultSettings('/tmp'),
          activeCodexManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'wsl-account-1' }
          }
        })
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('keeps explicit host runtime on host', () => {
    expect(
      getInitialCodexRateLimitTarget(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'host',
          localAgentRuntime: 'host',
          terminalWindowsShell: 'wsl.exe',
          activeCodexManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'wsl-account-1' }
          }
        },
        'win32'
      )
    ).toEqual({ runtime: 'host' })
  })
})
