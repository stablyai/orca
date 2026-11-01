import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Paired page.tasks consumes this projection; non-array persisted teams crashed it in 1.4.207 (0a2b6e7f).
function projectionOf(settings: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() reads nothing but store.getSettings(); every other RuntimeStore member is unreachable from that path.
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

function hostSettings(overrides: Record<string, unknown>): Partial<GlobalSettings> {
  return {
    ...createGlobalSettingsFixture({ workspaceDir: '/w' }),
    ...overrides
  }
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
