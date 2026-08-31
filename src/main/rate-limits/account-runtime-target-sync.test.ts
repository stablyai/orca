import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { RateLimitState } from '../../shared/rate-limit-types'
import { createAccountRuntimeTargetSettingsSync } from './account-runtime-target-sync'

function createServiceTargets(
  claudeTarget: RateLimitState['claudeTarget'],
  codexTarget: RateLimitState['codexTarget']
) {
  const state = { claudeTarget, codexTarget } as RateLimitState
  return {
    getState: vi.fn(() => state),
    refresh: vi.fn(async () => state),
    refreshClaudeForTarget: vi.fn(async () => state),
    refreshCodexForTarget: vi.fn(async () => state),
    setAntigravityFetchTarget: vi.fn()
  }
}

describe('createAccountRuntimeTargetSettingsSync', () => {
  it('retargets and refreshes runtime-backed providers when auto changes to WSL', async () => {
    const service = createServiceTargets(
      { runtime: 'host', wslDistro: null },
      { runtime: 'host', wslDistro: null }
    )
    const settings = {
      ...getDefaultSettings('/tmp'),
      localAccountRuntime: 'auto' as const,
      localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' }
    }
    const syncSettings = createAccountRuntimeTargetSettingsSync(
      service,
      getDefaultSettings('/tmp'),
      'win32'
    )

    await syncSettings(
      { localWindowsRuntimeDefault: settings.localWindowsRuntimeDefault },
      settings
    )

    const expectedTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    expect(service.refreshClaudeForTarget).toHaveBeenCalledOnce()
    expect(service.refreshClaudeForTarget).toHaveBeenCalledWith(expectedTarget)
    expect(service.refreshCodexForTarget).toHaveBeenCalledOnce()
    expect(service.refreshCodexForTarget).toHaveBeenCalledWith(expectedTarget)
    expect(service.setAntigravityFetchTarget).toHaveBeenCalledWith(expectedTarget)
    expect(service.refresh).toHaveBeenCalledOnce()
  })

  it('does no work for unrelated settings updates', async () => {
    const service = createServiceTargets(
      { runtime: 'host', wslDistro: null },
      { runtime: 'host', wslDistro: null }
    )
    const settings = getDefaultSettings('/tmp')
    const syncSettings = createAccountRuntimeTargetSettingsSync(service, settings, 'win32')

    await syncSettings({ theme: 'dark' }, settings)

    expect(service.getState).not.toHaveBeenCalled()
    expect(service.refreshClaudeForTarget).not.toHaveBeenCalled()
    expect(service.refreshCodexForTarget).not.toHaveBeenCalled()
    expect(service.setAntigravityFetchTarget).not.toHaveBeenCalled()
    expect(service.refresh).not.toHaveBeenCalled()
  })

  it('preserves a manual runtime when the settings-derived policy does not change', async () => {
    const service = createServiceTargets(
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      { runtime: 'wsl', wslDistro: 'Ubuntu' }
    )
    const initialSettings = {
      ...getDefaultSettings('/tmp'),
      localAccountRuntime: 'host' as const
    }
    const settings = {
      ...initialSettings,
      localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' }
    }
    const syncSettings = createAccountRuntimeTargetSettingsSync(service, initialSettings, 'win32')

    await syncSettings(
      { localWindowsRuntimeDefault: settings.localWindowsRuntimeDefault },
      settings
    )

    expect(service.getState).not.toHaveBeenCalled()
    expect(service.refreshClaudeForTarget).not.toHaveBeenCalled()
    expect(service.refreshCodexForTarget).not.toHaveBeenCalled()
    expect(service.setAntigravityFetchTarget).not.toHaveBeenCalled()
    expect(service.refresh).not.toHaveBeenCalled()
  })

  it('skips targeted refreshes for providers already on the next runtime', async () => {
    const service = createServiceTargets(
      { runtime: 'host', wslDistro: null },
      { runtime: 'wsl', wslDistro: 'Ubuntu' }
    )
    const initialSettings = {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' }
    }
    const settings = getDefaultSettings('/tmp')
    const syncSettings = createAccountRuntimeTargetSettingsSync(service, initialSettings, 'win32')

    await syncSettings(
      { localWindowsRuntimeDefault: settings.localWindowsRuntimeDefault },
      settings
    )

    expect(service.refreshClaudeForTarget).not.toHaveBeenCalled()
    expect(service.refreshCodexForTarget).toHaveBeenCalledOnce()
    expect(service.refreshCodexForTarget).toHaveBeenCalledWith({ runtime: 'host' })
    expect(service.setAntigravityFetchTarget).toHaveBeenCalledWith({
      runtime: 'host',
      wslDistro: null
    })
    expect(service.refresh).toHaveBeenCalledOnce()
  })
})
