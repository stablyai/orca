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
    refreshClaudeForTarget: vi.fn(async () => state),
    refreshCodexForTarget: vi.fn(async () => state)
  }
}

describe('createAccountRuntimeTargetSettingsSync', () => {
  it('retargets only Claude and Codex when auto changes to WSL', async () => {
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
  })

  it('refreshes only the provider whose current target differs', async () => {
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
  })
})
