import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
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
