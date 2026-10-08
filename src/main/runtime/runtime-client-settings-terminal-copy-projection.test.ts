import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Why: `settings.get` is an explicit allowlist, not the whole settings object.
// Mobile's terminal Copy reads terminalCopyTrimsGutter from it (#19770), and a
// field missing here is indistinguishable on the client from an older host —
// so the opt-out would silently never arrive.
function projectionOf(settings: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() reads nothing but store.getSettings(); every other RuntimeStore member is unreachable from that path.
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

function hostSettings(overrides: Partial<GlobalSettings>): Partial<GlobalSettings> {
  return { ...createGlobalSettingsFixture({ workspaceDir: '/w' }), ...overrides }
}

describe('RuntimeClientSettingsController terminal copy projection', () => {
  it('publishes the gutter-trim opt-out to paired clients', () => {
    expect(
      projectionOf(hostSettings({ terminalCopyTrimsGutter: false })).terminalCopyTrimsGutter
    ).toBe(false)
  })

  it('publishes the gutter-trim opt-in to paired clients', () => {
    expect(
      projectionOf(hostSettings({ terminalCopyTrimsGutter: true })).terminalCopyTrimsGutter
    ).toBe(true)
  })

  it('reports on when the host has no persisted preference', () => {
    const settings = hostSettings({})
    delete settings.terminalCopyTrimsGutter
    expect(projectionOf(settings).terminalCopyTrimsGutter).toBe(true)
  })
})
