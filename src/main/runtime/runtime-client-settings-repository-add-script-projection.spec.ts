import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

function hostSettings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...createGlobalSettingsFixture({ workspaceDir: '/w' }), ...overrides }
}

function controllerFor(settings: GlobalSettings) {
  const updateSettings = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() and update() touch only getSettings/updateSettings on this path.
  const controller = new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings
  } as never)
  return { controller, updateSettings }
}

describe('RuntimeClientSettingsController repository add script', () => {
  const optIn = { includeRepositoryAddScript: true }

  it('publishes the configured script exactly when the request opts in', () => {
    const script = '#!/bin/sh\n  echo hi \n'
    expect(
      controllerFor(hostSettings({ repositoryAddScript: script })).controller.get(optIn)
        .repositoryAddScript
    ).toBe(script)
  })

  it('omits the script by default and for a non-true flag', () => {
    const { controller } = controllerFor(hostSettings({ repositoryAddScript: 'echo hi' }))
    expect('repositoryAddScript' in controller.get()).toBe(false)
    expect('repositoryAddScript' in controller.get({})).toBe(false)
    expect('repositoryAddScript' in controller.get({ includeRepositoryAddScript: false })).toBe(
      false
    )
  })

  it('omits the key when unconfigured', () => {
    const settings = hostSettings({})
    delete settings.repositoryAddScript
    expect('repositoryAddScript' in controllerFor(settings).controller.get(optIn)).toBe(false)
  })

  it('does not publish a malformed stored value', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: persisted settings can violate the declared type.
    const settings = hostSettings({ repositoryAddScript: 5 as unknown as string })
    expect('repositoryAddScript' in controllerFor(settings).controller.get(optIn)).toBe(false)
  })

  it('forwards the script from settings.update to the host store', async () => {
    const { controller, updateSettings } = controllerFor(hostSettings({}))
    await controller.update({ repositoryAddScript: 'echo hi' })
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryAddScript: 'echo hi' }),
      { notifyListeners: true }
    )
  })
})
