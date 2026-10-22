import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import { getDefaultPersistedState } from '../../../shared/constants'
import { LoadedCohortMigrationOperations } from './loaded-cohort-migrations'

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn()
}))

afterEach(() => vi.resetAllMocks())

describe('onboarding language experiment', () => {
  it.each([
    { draw: 0, cohort: 'control' },
    { draw: 1, cohort: 'treatment' }
  ])(
    'assigns and freezes the $cohort experience with the system language for a new install',
    ({ draw, cohort }) => {
      vi.mocked(crypto.randomInt).mockImplementation(() => draw)
      const runtime = { loadNeedsSave: false }
      const migration = new LoadedCohortMigrationOperations(runtime)
      const fresh = migration.migrateTelemetry(getDefaultPersistedState('/test'), false)
      expect(fresh.settings.telemetry?.onboardingLanguageCohort).toBe(cohort)
      expect(fresh.settings.uiLanguage).toBe('system')
      expect(runtime.loadNeedsSave).toBe(true)
      const reopened = migration.migrateTelemetry(JSON.parse(JSON.stringify(fresh)), true)
      expect(reopened).toEqual(fresh)
      expect(crypto.randomInt).toHaveBeenCalledExactlyOnceWith(2)
    }
  )

  it('excludes existing profiles and preserves their language', () => {
    const migration = new LoadedCohortMigrationOperations({ loadNeedsSave: false })
    const profile = getDefaultPersistedState('/test')
    profile.settings.uiLanguage = 'fr'
    const upgraded = migration.migrateTelemetry(profile, true)
    expect(upgraded.settings.telemetry?.onboardingLanguageCohort).toBeUndefined()
    expect(upgraded.settings.uiLanguage).toBe('fr')
    expect(crypto.randomInt).not.toHaveBeenCalled()
    expect(migration.migrateTelemetry(upgraded, true)).toEqual(upgraded)
  })
})
