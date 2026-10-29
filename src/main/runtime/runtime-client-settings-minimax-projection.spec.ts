import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Missing projection fields silently use client defaults; real get covers region/link data hidden by RPC controller mocks.
function getProjected(overrides: Partial<GlobalSettings>) {
  const settings = createGlobalSettingsFixture({ workspaceDir: '/w', ...overrides })
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

describe('RuntimeClientSettingsController MiniMax projection', () => {
  it('publishes and updates the machine name setting', async () => {
    const settings = createGlobalSettingsFixture({ workspaceDir: '/w', machineName: 'desk' })
    const store = {
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
    }
    const controller = new RuntimeClientSettingsController(store)
    expect(controller.get().machineName).toBe('desk')
    await controller.update({ machineName: 'build-server' })
    expect(settings.machineName).toBe('build-server')
    expect(controller.get().machineName).toBe('build-server')
  })

  it('publishes the China endpoint to paired clients', () => {
    expect(getProjected({ minimaxEndpoint: 'cn' }).minimaxEndpoint).toBe('cn')
  })

  it('publishes the overseas endpoint to paired clients', () => {
    expect(getProjected({ minimaxEndpoint: 'overseas' }).minimaxEndpoint).toBe('overseas')
  })

  it('falls back to overseas when the host has no persisted endpoint', () => {
    const settings = createGlobalSettingsFixture({ workspaceDir: '/w' })
    delete (settings as Partial<GlobalSettings>).minimaxEndpoint
    const projected = new RuntimeClientSettingsController({
      getSettings: () => settings
    } as never).get()
    expect(projected.minimaxEndpoint).toBe('overseas')
  })
})

describe('execution-host agent notification mode', () => {
  it('saves the host choice through paired settings without replacing sound and delivery preferences', async () => {
    const settings = createGlobalSettingsFixture()
    const original = settings.notifications
    const controller = new RuntimeClientSettingsController({
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
    })
    expect(controller.get().agentNotificationMode).toBe('current')
    await controller.update({ agentNotificationMode: 'action-or-flow-complete' })
    expect(controller.get().agentNotificationMode).toBe('action-or-flow-complete')
    expect(settings.notifications).toEqual({
      ...original,
      agentNotificationMode: 'action-or-flow-complete'
    })
  })
})
