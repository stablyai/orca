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
  it('turns the sync on for a new profile', () => {
    expect(seed(getDefaultPersistedState('/home/user'), false)).toMatchObject({
      claudeCodeThemeSync: true,
      claudeCodeThemeSyncOffer: 'settled'
    })
  })

  it('keeps an existing profile off and owes it the offer, even when a writer copied the default in', () => {
    const existing = getDefaultPersistedState('/home/user')
    expect(seed(existing, true)).toMatchObject({
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
