import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Why: the projection is what paired clients render page.tasks from, and a
// non-array in the host store crashed that page in 1.4.207 (0a2b6e7f).
function projectionOf(settings: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() reads nothing but store.getSettings(); every other RuntimeStore member is unreachable from that path.
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

function hostSettings(overrides: Record<string, unknown>): Partial<GlobalSettings> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the override deliberately carries the malformed on-disk shape the projection must tolerate.
  return {
    ...createGlobalSettingsFixture({ workspaceDir: '/w' }),
    ...overrides
  } as Partial<GlobalSettings>
}

describe('RuntimeClientSettingsController Linear team selection projection', () => {
  it('publishes a saved team array unchanged', () => {
    expect(
      projectionOf(hostSettings({ defaultLinearTeamSelection: ['t1', 't2'] }))
        .defaultLinearTeamSelection
    ).toEqual(['t1', 't2'])
  })

  it('publishes sticky-all as null', () => {
    expect(
      projectionOf(hostSettings({ defaultLinearTeamSelection: null })).defaultLinearTeamSelection
    ).toBeNull()
  })

  it('publishes only string team IDs from a malformed array', () => {
    expect(
      projectionOf(hostSettings({ defaultLinearTeamSelection: ['t1', 7, null, {}, 't2'] }))
        .defaultLinearTeamSelection
    ).toEqual(['t1', 't2'])
  })

  it('publishes null when the host store holds a string or an object', () => {
    expect(
      projectionOf(hostSettings({ defaultLinearTeamSelection: 't1' })).defaultLinearTeamSelection
    ).toBeNull()
    expect(
      projectionOf(hostSettings({ defaultLinearTeamSelection: { 0: 't1' } }))
        .defaultLinearTeamSelection
    ).toBeNull()
  })
})
