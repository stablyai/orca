import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TelemetrySettings } from '../../../shared/telemetry-settings-types'
import { LoadedCohortMigrationOperations } from './loaded-cohort-migrations'

const seed = (state: PersistedState, fileExistedOnLoad: boolean) =>
  new LoadedCohortMigrationOperations({ loadNeedsSave: false }).migrateCohortSeeds(
    state,
    fileExistedOnLoad
  ).settings

describe('Claude Code theme sync cohort', () => {
  it.each([
    ['new', false],
    ['existing', true]
  ])('keeps a %s profile off and owes it the offer', (_cohort, fileExistedOnLoad) => {
    expect(seed(getDefaultPersistedState('/home/user'), fileExistedOnLoad)).toMatchObject({
      claudeCodeThemeSync: false,
      claudeCodeThemeSyncOffer: 'pending'
    })
  })

  it('never re-offers once the offer settled', () => {
    const state = getDefaultPersistedState('/home/user')
    const settled = {
      ...state,
      settings: {
        ...state.settings,
        claudeCodeThemeSync: false,
        claudeCodeThemeSyncOffer: 'settled' as const
      }
    }
    expect(seed(settled, true)).toMatchObject({
      claudeCodeThemeSync: false,
      claudeCodeThemeSyncOffer: 'settled'
    })
  })
})

describe('protected milestone install cohort', () => {
  const migrate = (state: PersistedState, fileExistedOnLoad: boolean) =>
    new LoadedCohortMigrationOperations({ loadNeedsSave: false }).migrateTelemetry(
      state,
      fileExistedOnLoad
    ).settings.telemetry?.protectedMilestones

  const withTelemetry = (
    protectedMilestones?: TelemetrySettings['protectedMilestones']
  ): PersistedState => {
    const state = getDefaultPersistedState('/home/user')
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          optedIn: true,
          installId: 'install-1',
          existedBeforeTelemetryRelease: false,
          ...(protectedMilestones ? { protectedMilestones } : {})
        }
      }
    }
  }

  it('marks a profile created on this load fresh', () => {
    expect(migrate(getDefaultPersistedState('/home/user'), false)).toEqual({
      installCohort: 'fresh'
    })
  })

  it('marks an upgraded profile existing without touching its cursors', () => {
    expect(migrate(withTelemetry({ meaningfulActivityDay: 20_000 }), true)).toEqual({
      installCohort: 'existing',
      meaningfulActivityDay: 20_000
    })
  })

  it('never re-freezes a cohort already recorded', () => {
    expect(migrate(withTelemetry({ installCohort: 'fresh' }), true)).toEqual({
      installCohort: 'fresh'
    })
  })
})
