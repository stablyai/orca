import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Missing nativeChatQueueFollowUps looks like an older host to mobile, which then queues mid-turn sends.
function projectionOf(settings: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() reads nothing but store.getSettings(); every other RuntimeStore member is unreachable from that path.
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

function hostSettings(overrides: Partial<GlobalSettings>): Partial<GlobalSettings> {
  return { ...createGlobalSettingsFixture({ workspaceDir: '/w' }), ...overrides }
}

describe('RuntimeClientSettingsController queue follow-ups projection', () => {
  it('publishes the opt-out to paired clients', () => {
    expect(
      projectionOf(hostSettings({ nativeChatQueueFollowUps: false })).nativeChatQueueFollowUps
    ).toBe(false)
  })

  it('reports on when the host has no persisted preference', () => {
    const settings = hostSettings({})
    delete settings.nativeChatQueueFollowUps
    expect(projectionOf(settings).nativeChatQueueFollowUps).toBe(true)
  })
})
