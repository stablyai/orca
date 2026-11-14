import { closeTestStores, createStore, testState, writeDataFile } from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-onboarding-language-cohort-'))
})
afterEach(async () => {
  await closeTestStores()
  vi.resetAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('persisted onboarding language cohorts', () => {
  it('does not assign a historical setting to a fresh profile, including after restart', async () => {
    const store = createStore()
    const telemetry = store.getSettings().telemetry
    if (!telemetry) {
      throw new Error('Fresh profile has no telemetry settings')
    }
    expect(telemetry.onboardingLanguageCohort).toBeUndefined()
    expect(store.getSettings().uiLanguage).toBe('system')
    store.flush()
    await closeTestStores()
    expect(createStore().getSettings().telemetry?.onboardingLanguageCohort).toBeUndefined()
  })

  it.each(['control', 'treatment'] as const)(
    'retains the historical setting through migration, settings changes and restart',
    async (cohort) => {
      writeDataFile({ settings: { telemetry: { onboardingLanguageCohort: cohort } } })
      const store = createStore()
      const telemetry = store.getSettings().telemetry
      if (!telemetry) {
        throw new Error('Migrated profile has no telemetry settings')
      }
      expect(telemetry.onboardingLanguageCohort).toBe(cohort)
      store.updateSettings({ uiLanguage: 'fr' })
      store.updateSettings({ telemetry: { ...telemetry, optedIn: false } })
      store.flush()
      await closeTestStores()

      const reopened = createStore()
      expect(reopened.getSettings().telemetry).toEqual({ ...telemetry, optedIn: false })
      expect(reopened.getSettings().uiLanguage).toBe('fr')
    }
  )

  it('keeps a previously migrated profile excluded through restart', async () => {
    writeDataFile({
      settings: {
        uiLanguage: 'ja',
        telemetry: {
          optedIn: false,
          installId: 'existing-profile',
          existedBeforeTelemetryRelease: false
        }
      }
    })
    const store = createStore()
    store.flush()
    await closeTestStores()
    const reopened = createStore()
    expect(reopened.getSettings().telemetry?.onboardingLanguageCohort).toBeUndefined()
    expect(reopened.getSettings().telemetry?.optedIn).toBe(false)
    expect(reopened.getSettings().uiLanguage).toBe('ja')
  })
})
